import { createHash } from 'node:crypto';

import type { Executor, ResultadoDeComando } from '../../../scripts/verify-fingerprint-migration';
import {
  verificar,
  argumentosPsql,
  assertIdentificadorSeguro,
  fingerprintEsperado,
  nomeDescartavel,
  VerificacaoFalhou,
} from '../../../scripts/verify-fingerprint-migration';

describe('nome do banco descartavel', () => {
  it('usa prefixo proprio e sufixo do gerador', () => {
    expect(nomeDescartavel(() => 'abc123')).toBe('payment_migration_check_abc123');
  });

  it('muda a cada execucao, para nao colidir com banco alheio', () => {
    // Nome fixo com DROP DATABASE IF EXISTS apagaria um banco preexistente de
    // mesmo nome — achado 4.2 do terceiro review do PR #52.
    expect(nomeDescartavel()).not.toBe(nomeDescartavel());
  });

  it.each([
    ['ponto e virgula', 'banco; DROP DATABASE producao'],
    ['aspas', 'banco"x'],
    ['maiuscula inicial', 'Banco'],
    ['hifen', 'payment-check'],
    ['vazio', ''],
    ['comeca com numero', '1banco'],
    ['longo demais', 'a'.repeat(64)],
  ])('recusa identificador com %s', (_rotulo, nome) => {
    // CREATE DATABASE nao aceita parametro vinculado: o nome entra no texto do
    // SQL, entao o charset e validado e nao se confia no gerador.
    expect(() => assertIdentificadorSeguro(nome)).toThrow(VerificacaoFalhou);
  });

  it('recusa nome gerado invalido mesmo vindo do proprio gerador', () => {
    expect(() => nomeDescartavel(() => 'x; DROP')).toThrow(VerificacaoFalhou);
  });
});

describe('argumentos do psql', () => {
  const SENHA = 'senha_secreta_do_postgres';

  it('NAO carrega a senha em nenhum argumento', () => {
    const args = argumentosPsql('usuario', 'banco');

    // Achado 3.2: com a senha no argv ela fica visivel em `ps`. Ela viaja no env
    // do processo filho, e o docker recebe o NOME da variavel, nao o valor.
    expect(args.join(' ')).not.toContain(SENHA);
    expect(args.join(' ')).not.toContain('PGPASSWORD=');
  });

  it('encaminha PGPASSWORD pelo ambiente, como argumentos separados', () => {
    const args = argumentosPsql('usuario', 'banco');
    const i = args.indexOf('-e');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('PGPASSWORD');
  });

  it('mantem cada valor como argumento proprio, sem interpolacao de shell', () => {
    const args = argumentosPsql('usuario', 'banco', ['-1']);
    expect(args).toContain('usuario');
    expect(args).toContain('banco');
    expect(args).toContain('-1');
    // Nenhum argumento pode conter espaco: sinal de string montada a mao.
    expect(args.filter((a) => a.includes(' ') && !a.endsWith('.yml'))).toEqual([]);
  });
});

describe('receita do fingerprint', () => {
  it('e a mesma do servico', () => {
    expect(fingerprintEsperado('ord-alpha')).toBe(
      createHash('sha256').update('v1:ord-alpha').digest('hex'),
    );
  });
});

describe('limpeza dos bancos descartaveis', () => {
  interface Chamada {
    comando: string;
    args: string[];
    entrada?: string;
  }

  function executorFalso(
    responder: (c: Chamada, indice: number) => ResultadoDeComando,
  ): { executor: Executor; chamadas: Chamada[] } {
    const chamadas: Chamada[] = [];
    const executor: Executor = (comando, args, _env, entrada) => {
      const chamada: Chamada = { comando, args, entrada };
      chamadas.push(chamada);
      return responder(chamada, chamadas.length - 1);
    };
    return { executor, chamadas };
  }

  const ok: ResultadoDeComando = { status: 0, stdout: '', stderr: '' };
  const falha: ResultadoDeComando = { status: 1, stdout: '', stderr: 'erro simulado' };

  function dropsEmitidos(chamadas: Chamada[]): string[] {
    return chamadas
      .map((c) => c.entrada ?? '')
      .filter((e) => e.includes('DROP DATABASE'));
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('NAO emite DROP quando o CREATE DATABASE falha por colisao', () => {
    // Cenario do bloqueante: o nome ja existe, o CREATE falha, e o script deve
    // apenas parar. Registrar o nome ANTES da criacao fazia o finally apagar o
    // banco preexistente — o oposto da propriedade anunciada.
    const { executor, chamadas } = executorFalso((c) =>
      c.entrada?.includes('CREATE DATABASE') ? falha : ok,
    );

    expect(verificar(executor)).toBe(1);
    expect(chamadas.some((c) => c.entrada?.includes('CREATE DATABASE'))).toBe(true);
    expect(dropsEmitidos(chamadas)).toEqual([]);
  });

  it('EMITE DROP do banco que esta execucao criou, quando a falha vem depois', () => {
    // Controle. Sem ele, o teste acima passaria mesmo que o script nunca
    // limpasse nada — "nenhum DROP" seria verdade pelo motivo errado.
    const { executor, chamadas } = executorFalso((c) =>
      c.comando === 'npx' ? falha : ok,
    );

    expect(verificar(executor)).toBe(1);

    const drops = dropsEmitidos(chamadas);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain('payment_migration_check_');
  });

  // NAO existe aqui um teste de "os dois cenarios completam e removem dois
  // bancos". Para o duble chegar ao fim, ele teria de devolver o stdout de cada
  // consulta com o valor exato que a assercao espera — ou seja, eu simularia o
  // Postgres e o teste passaria a medir a simulacao, nao o script. Pior: os
  // valores esperados ficariam escritos em dois lugares e divergiriam em
  // silencio.
  //
  // Esse caminho e coberto pela execucao REAL, `npm run verify:migration`, que
  // roda os dois cenarios contra o Postgres e remove os dois bancos. O que os
  // dois testes acima cobrem e a decisao de LIMPEZA, que independe do banco.
});
