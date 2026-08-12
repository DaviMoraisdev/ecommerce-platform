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

function main(): void {
  try {
    const env = validarAlvoDeMigracao({ base: process.env });

    console.log(`Aplicando migrations em ${BANCO_DE_TESTE}...`);

    const resultado = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'inherit',
      env,
    });

    process.exit(resultado.status ?? 1);
  } catch (erro) {
    console.error((erro as Error).message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
