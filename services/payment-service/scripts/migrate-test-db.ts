import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import dotenv from 'dotenv';

import {
  assertTestDatabase,
  BANCO_DE_TESTE,
  GuardaDeBancoError,
} from '../tests/helpers/testDbGuard';

/**
 * Aplica migrations no banco de TESTE, validando o destino antes.
 *
 * A versao anterior deste script era shell com um parser de URL feito a mao, e
 * tinha tres falhas:
 *   1. `postgresql://u:senha@host` (sem path) fazia a regex capturar
 *      "u:senha@host" — e o script IMPRIMIA isso, vazando a credencial;
 *   2. `.../producao?schema=x/banco_test` era aceito, porque o `.*` guloso ia
 *      ate a ultima barra, dentro da query string;
 *   3. validava 3 de 4 barreiras — faltava host local, entao migration em banco
 *      REMOTO com o nome esperado passava sem opt-in.
 *
 * A correcao nao foi consertar a regex: foi parar de reimplementar a politica.
 * Este script IMPORTA a mesma guarda que protege os testes destrutivos, que usa
 * `new URL()` (parsing estrutural), aplica as quatro barreiras e nunca interpola
 * a URL na mensagem de erro.
 */

export class MigracaoAbortada extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigracaoAbortada';
  }
}

export interface OpcoesDeValidacao {
  /** Arquivo de ambiente de teste. Default: `.env.test` no diretorio atual. */
  arquivo?: string;
  /**
   * Ambiente base do processo, usado SO para compor o env do comando filho
   * (PATH, HOME). NUNCA participa da validacao — ver a nota abaixo.
   */
  base?: NodeJS.ProcessEnv;
}

/**
 * Valida o destino e devolve o ambiente para o comando de migration.
 *
 * PONTO CRITICO: a validacao roda sobre APENAS o que foi lido do arquivo, nao
 * sobre a mistura com process.env. Se o arquivo nao tiver DATABASE_URL e o
 * shell tiver, validar a mistura aprovaria a URL herdada — que e exatamente o
 * cenario contra o qual este script existe.
 */
export function validarAlvoDeMigracao(opcoes: OpcoesDeValidacao = {}): NodeJS.ProcessEnv {
  const arquivo = opcoes.arquivo ?? '.env.test';

  let conteudo: string;
  try {
    conteudo = readFileSync(arquivo, 'utf8');
  } catch {
    throw new MigracaoAbortada(
      `ABORTADO para proteger dados: ${arquivo} nao pode ser lido. ` +
        `Copie de ${arquivo}.example.`,
    );
  }

  // dotenv.parse e puro: nao toca process.env.
  const doArquivo = dotenv.parse(conteudo);

  try {
    assertTestDatabase(doArquivo);
  } catch (erro) {
    if (erro instanceof GuardaDeBancoError) {
      // A mensagem da guarda ja e sanitizada: ela nunca contem a URL.
      throw new MigracaoAbortada(erro.message);
    }
    throw erro;
  }

  // Somente APOS validar, compoe o env do filho. O arquivo tem precedencia.
  return { ...(opcoes.base ?? {}), ...doArquivo };
}

export interface DependenciasDeExecucao {
  /**
   * Argumentos do npx. Default: aplicar migrations.
   *
   * Existe para que o RESET do banco de teste passe pela MESMA guarda, em vez de
   * replicar a politica num comando solto. Tentei a replicacao inline uma vez e
   * ela quebrou por expansao de historico do bash — reimplementar politica de
   * seguranca em outro lugar e o erro, nao o detalhe de sintaxe.
   */
  argumentos?: string[];
  /** Injetavel para teste: assinatura compativel com child_process.spawnSync. */
  spawn?: typeof spawnSync;
  log?: (mensagem: string) => void;
  reportarErro?: (mensagem: string) => void;
}

/**
 * Valida o destino e, SO se ele for valido, executa a migration.
 *
 * Devolve o codigo de saida em vez de chamar process.exit, para que o comando,
 * os argumentos, o ambiente entregue ao subprocesso e a propagacao do exit code
 * sejam verificaveis em teste. O `main` abaixo e quem traduz para process.exit.
 */
export function executarMigracao(
  opcoes: OpcoesDeValidacao & DependenciasDeExecucao = {},
): number {
  const spawn = opcoes.spawn ?? spawnSync;
  const log = opcoes.log ?? ((m: string) => console.log(m));
  const reportarErro = opcoes.reportarErro ?? ((m: string) => console.error(m));

  let env: NodeJS.ProcessEnv;
  try {
    env = validarAlvoDeMigracao(opcoes);
  } catch (erro) {
    reportarErro((erro as Error).message);
    // Retorno ANTES de qualquer spawn: validacao reprovada nao inicia migration.
    return 1;
  }

  const argumentos = opcoes.argumentos ?? ['prisma', 'migrate', 'deploy'];

  log(`Executando "npx ${argumentos.join(' ')}" em ${BANCO_DE_TESTE}...`);

  const resultado = spawn('npx', argumentos, {
    stdio: 'inherit',
    env,
  });

  if (resultado.error) {
    // Reporta apenas o codigo do erro (ex.: ENOENT), nunca o objeto inteiro:
    // ele pode carregar spawnargs e outros campos derivados do ambiente.
    const codigo = (resultado.error as NodeJS.ErrnoException).code ?? resultado.error.name;
    reportarErro(
      `ABORTADO: nao foi possivel executar "npx ${argumentos.join(' ')}" (${codigo}). ` +
        'Verifique se o Node e o npm estao no PATH.',
    );
    return 1;
  }

  return resultado.status ?? 1;
}

function main(): void {
  process.exit(executarMigracao({ base: process.env }));
}

if (require.main === module) {
  main();
}
