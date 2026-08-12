import type { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executarMigracao,
  MigracaoAbortada,
  validarAlvoDeMigracao,
} from '../../scripts/migrate-test-db';
import { BANCO_DE_TESTE } from '../helpers/testDbGuard';

/**
 * Testes do controle que protege a MIGRATION.
 *
 * A politica em si (quatro barreiras, parsing estrutural) e testada em
 * testDbGuard.test.ts — aqui o alvo e o invólucro: carregar o arquivo, validar
 * SO o que veio dele, e nunca deixar credencial na mensagem de erro.
 *
 * Os casos marcados REGRESSAO correspondem a falhas reais da versao anterior em
 * shell, apontadas em revisao.
 */

const SENHA = 'SenhaSuperSecretaDoTeste';

// Cada arquivo de fixture cria um diretorio temporario. Sem limpeza, uma
// execucao das tres suites deixa dezenas deles em /tmp.
const temporarios: string[] = [];

afterEach(() => {
  while (temporarios.length > 0) {
    rmSync(temporarios.pop() as string, { recursive: true, force: true });
  }
});

function arquivoCom(pares: Record<string, string | undefined>): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-alvo-'));
  temporarios.push(dir);
  const arquivo = join(dir, '.env.test');
  const linhas = Object.entries(pares)
    .filter(([, valor]) => valor !== undefined)
    .map(([chave, valor]) => `${chave}=${valor}`);
  writeFileSync(arquivo, linhas.join('\n') + '\n');
  return arquivo;
}

function valido(overrides: Record<string, string | undefined> = {}): string {
  return arquivoCom({
    DATABASE_URL: `postgresql://usuario:${SENHA}@127.0.0.1:5432/${BANCO_DE_TESTE}`,
    NODE_ENV: 'test',
    ALLOW_TEST_DB_RESET: 'true',
    ...overrides,
  });
}

function capturar(fn: () => unknown): Error {
  try {
    fn();
  } catch (erro) {
    return erro as Error;
  }
  throw new Error('esperava MigracaoAbortada, mas a validacao PASSOU');
}

describe('validarAlvoDeMigracao — caminho valido', () => {
  it('devolve o ambiente com o DATABASE_URL do arquivo', () => {
    const env = validarAlvoDeMigracao({ arquivo: valido() });

    expect(env.DATABASE_URL).toContain(BANCO_DE_TESTE);
    expect(env.NODE_ENV).toBe('test');
  });

  it('o arquivo tem precedencia, e a base preserva o resto do ambiente', () => {
    const env = validarAlvoDeMigracao({
      arquivo: valido(),
      base: { PATH: '/caminho/de/teste', DATABASE_URL: 'postgresql://x:y@z/outro' },
    });

    expect(env.PATH).toBe('/caminho/de/teste');
    expect(env.DATABASE_URL).toContain(BANCO_DE_TESTE);
  });

  it('aceita host remoto COM opt-in explicito', () => {
    expect(() =>
      validarAlvoDeMigracao({
        arquivo: valido({
          DATABASE_URL: `postgresql://u:p@db.remoto.exemplo:5432/${BANCO_DE_TESTE}`,
          ALLOW_REMOTE_TEST_DB: 'true',
        }),
      }),
    ).not.toThrow();
  });
});

describe('validarAlvoDeMigracao — recusas', () => {
  it('aborta quando o arquivo nao existe', () => {
    const erro = capturar(() =>
      validarAlvoDeMigracao({ arquivo: '/caminho/que/nao/existe/.env.test' }),
    );

    expect(erro).toBeInstanceOf(MigracaoAbortada);
    expect(erro.message).toContain('nao pode ser lido');
  });

  it.each([
    ['DATABASE_URL ausente', { DATABASE_URL: undefined }],
    ['DATABASE_URL vazia', { DATABASE_URL: '' }],
    ['NODE_ENV ausente', { NODE_ENV: undefined }],
    ['NODE_ENV diferente de test', { NODE_ENV: 'development' }],
    ['ALLOW_TEST_DB_RESET ausente', { ALLOW_TEST_DB_RESET: undefined }],
    ['ALLOW_TEST_DB_RESET com valor truthy qualquer', { ALLOW_TEST_DB_RESET: '1' }],
  ])('aborta com %s', (_rotulo, override) => {
    const erro = capturar(() => validarAlvoDeMigracao({ arquivo: valido(override) }));
    expect(erro).toBeInstanceOf(MigracaoAbortada);
  });

  it('aborta quando o banco alvo e o de desenvolvimento', () => {
    const alvoErrado = BANCO_DE_TESTE.replace('_test_db', '_db');
    const erro = capturar(() =>
      validarAlvoDeMigracao({
        arquivo: valido({ DATABASE_URL: `postgresql://u:p@127.0.0.1:5432/${alvoErrado}` }),
      }),
    );

    expect(erro).toBeInstanceOf(MigracaoAbortada);
    expect(erro.message).toContain(alvoErrado);
  });

  it('REGRESSAO: aborta em host remoto SEM opt-in', () => {
    // A versao em shell nao checava host: migration em banco remoto com o nome
    // esperado passava sem consentimento.
    const erro = capturar(() =>
      validarAlvoDeMigracao({
        arquivo: valido({
          DATABASE_URL: `postgresql://u:p@db.remoto.exemplo:5432/${BANCO_DE_TESTE}`,
        }),
      }),
    );

    expect(erro).toBeInstanceOf(MigracaoAbortada);
    expect(erro.message).toContain('nao e local');
  });

  it('REGRESSAO: aborta quando o nome esperado aparece na QUERY STRING', () => {
    // A regex do shell era gulosa e ia ate a ultima barra, dentro da query:
    // o banco real era "producao" e a validacao aprovava.
    const erro = capturar(() =>
      validarAlvoDeMigracao({
        arquivo: valido({
          DATABASE_URL: `postgresql://u:p@127.0.0.1:5432/producao?schema=x/${BANCO_DE_TESTE}`,
        }),
      }),
    );

    expect(erro).toBeInstanceOf(MigracaoAbortada);
    expect(erro.message).toContain('producao');
  });

  it('REGRESSAO: aborta em URL sem path, sem vazar a credencial', () => {
    // Aqui a regex do shell capturava "usuario:senha@host" e IMPRIMIA.
    const erro = capturar(() =>
      validarAlvoDeMigracao({
        arquivo: valido({ DATABASE_URL: `postgresql://usuario:${SENHA}@db.exemplo` }),
      }),
    );

    expect(erro).toBeInstanceOf(MigracaoAbortada);
    expect(erro.message).not.toContain(SENHA);
  });

  it('REGRESSAO: NAO valida o DATABASE_URL herdado do ambiente', () => {
    // Se a validacao rodasse sobre { ...process.env, ...arquivo }, um arquivo
    // sem DATABASE_URL seria aprovado com a URL do shell — o proprio cenario
    // que este controle existe para impedir.
    const erro = capturar(() =>
      validarAlvoDeMigracao({
        arquivo: valido({ DATABASE_URL: undefined }),
        base: {
          DATABASE_URL: `postgresql://u:p@127.0.0.1:5432/${BANCO_DE_TESTE}`,
          NODE_ENV: 'test',
          ALLOW_TEST_DB_RESET: 'true',
        },
      }),
    );

    expect(erro).toBeInstanceOf(MigracaoAbortada);
  });

  it.each(['nao-e-uma-url', 'postgresql://', '   '])(
    'aborta com URL malformada (%p)',
    (url) => {
      const erro = capturar(() => validarAlvoDeMigracao({ arquivo: valido({ DATABASE_URL: url }) }));
      expect(erro).toBeInstanceOf(MigracaoAbortada);
    },
  );
});

describe('validarAlvoDeMigracao — a senha NUNCA aparece na mensagem', () => {
  const cenarios: Array<[string, Record<string, string | undefined>]> = [
    ['banco de desenvolvimento', {
      DATABASE_URL: `postgresql://usuario:${SENHA}@127.0.0.1:5432/${BANCO_DE_TESTE.replace('_test_db', '_db')}`,
    }],
    ['host remoto', {
      DATABASE_URL: `postgresql://usuario:${SENHA}@db.remoto.exemplo:5432/${BANCO_DE_TESTE}`,
    }],
    ['URL sem path', { DATABASE_URL: `postgresql://usuario:${SENHA}@db.exemplo` }],
    ['barra na query', {
      DATABASE_URL: `postgresql://usuario:${SENHA}@127.0.0.1:5432/producao?schema=x/${BANCO_DE_TESTE}`,
    }],
    ['NODE_ENV errado', { NODE_ENV: 'production' }],
    ['sem opt-in', { ALLOW_TEST_DB_RESET: undefined }],
  ];

  it.each(cenarios)('%s', (_rotulo, override) => {
    const erro = capturar(() => validarAlvoDeMigracao({ arquivo: valido(override) }));

    expect(erro.message).not.toContain(SENHA);
    expect(erro.message).not.toContain('postgresql://');
  });
});

// ==========================================================
// A execucao: comando, ambiente, exit code e o caso mais
// importante — validacao reprovada NAO inicia migration
// ==========================================================

describe('executarMigracao', () => {
  function spawnFalso(retorno: Partial<SpawnSyncReturns<Buffer>> = {}) {
    return jest.fn(() => ({
      pid: 1,
      output: [],
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      status: 0,
      signal: null,
      ...retorno,
    })) as unknown as typeof spawnSync;
  }

  function coletores() {
    const logs: string[] = [];
    const erros: string[] = [];
    return {
      logs,
      erros,
      log: (m: string) => logs.push(m),
      reportarErro: (m: string) => erros.push(m),
    };
  }

  it('executa exatamente `npx prisma migrate deploy`', () => {
    const spawn = spawnFalso();
    const c = coletores();

    const codigo = executarMigracao({ arquivo: valido(), spawn, ...c });

    expect(codigo).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'npx',
      ['prisma', 'migrate', 'deploy'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('entrega ao subprocesso o ambiente VALIDADO, com a URL do arquivo', () => {
    const spawn = spawnFalso();
    const c = coletores();

    executarMigracao({
      arquivo: valido(),
      base: { PATH: '/caminho/de/teste' },
      spawn,
      ...c,
    });

    const opcoes = (spawn as unknown as jest.Mock).mock.calls[0][2];
    expect(opcoes.env.DATABASE_URL).toContain(BANCO_DE_TESTE);
    expect(opcoes.env.PATH).toBe('/caminho/de/teste');
  });

  it.each([0, 1, 2, 137])('propaga o exit code %i do Prisma', (status) => {
    const spawn = spawnFalso({ status });
    const c = coletores();

    expect(executarMigracao({ arquivo: valido(), spawn, ...c })).toBe(status);
  });

  it('status null vira codigo 1 — nunca sucesso por omissao', () => {
    const spawn = spawnFalso({ status: null });
    const c = coletores();

    expect(executarMigracao({ arquivo: valido(), spawn, ...c })).toBe(1);
  });

  it('falha de spawn produz diagnostico acionavel, sem vazar a senha', () => {
    const erroDeSpawn: NodeJS.ErrnoException = new Error('spawn npx ENOENT');
    erroDeSpawn.code = 'ENOENT';

    const spawn = spawnFalso({ status: null, error: erroDeSpawn });
    const c = coletores();

    expect(executarMigracao({ arquivo: valido(), spawn, ...c })).toBe(1);
    expect(c.erros.join('\n')).toContain('ENOENT');
    expect(c.erros.join('\n')).toContain('PATH');
    expect(c.erros.join('\n')).not.toContain(SENHA);
  });

  it('VALIDACAO REPROVADA nao chama spawn — nenhuma migration comeca', () => {
    const spawn = spawnFalso();
    const c = coletores();

    const codigo = executarMigracao({
      arquivo: valido({ DATABASE_URL: `postgresql://u:${SENHA}@db.remoto.exemplo/${BANCO_DE_TESTE}` }),
      spawn,
      ...c,
    });

    expect(codigo).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(c.logs).toHaveLength(0);
    expect(c.erros.join('\n')).toContain('nao e local');
    expect(c.erros.join('\n')).not.toContain(SENHA);
  });

  it('anuncia o banco alvo antes de executar', () => {
    const spawn = spawnFalso();
    const c = coletores();

    executarMigracao({ arquivo: valido(), spawn, ...c });

    expect(c.logs.join('\n')).toContain(BANCO_DE_TESTE);
  });
});
