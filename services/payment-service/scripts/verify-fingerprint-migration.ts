import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

/**
 * Prova a migration do fingerprint contra registros PREEXISTENTES.
 *
 * A primeira versao era shell e foi recusada no terceiro review do PR #52 por
 * cinco motivos, todos corrigidos aqui:
 *
 *   1. `eval` sobre texto derivado de DATABASE_URL — senha com `$(...)` viraria
 *      execucao arbitraria. Agora nao ha shell: spawnSync com array de
 *      argumentos, sem interpolacao.
 *   2. PGPASSWORD ia no argv do docker, visivel em `ps`. Agora viaja no env do
 *      processo filho, e o docker recebe `-e PGPASSWORD` SEM valor.
 *   3. Nome de banco fixo com DROP DATABASE IF EXISTS — apagaria um banco alheio
 *      de mesmo nome. Agora o nome e unico por execucao e a criacao FALHA se ja
 *      existir.
 *   4. Limpeza so na ultima linha: falha intermediaria deixava banco orfao.
 *      Agora e `finally`, e so remove o que esta execucao criou.
 *   5. Consultas informativas em vez de assercoes. Agora toda expectativa lanca.
 *
 * ATOMICIDADE. Medido: o Prisma ja envolve cada arquivo de migration em
 * transacao — uma migration com DDL seguido de RAISE deixou zero tabelas atras.
 * Por isso o arquivo NAO leva BEGIN/COMMIT proprio (aninhar fecharia a transacao
 * do Prisma cedo), e este verificador aplica com `psql -1` para reproduzir o
 * mesmo enquadramento do executor real.
 */

const RAIZ = path.resolve(__dirname, '..');
const COMPOSE = path.resolve(RAIZ, '..', '..', 'docker-compose.yml');
const PREFIXO = 'payment_migration_check_';

export class VerificacaoFalhou extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificacaoFalhou';
  }
}

export interface ResultadoDeComando {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Executor = (
  args: string[],
  env: NodeJS.ProcessEnv,
  entrada?: string,
) => ResultadoDeComando;

/** Nome unico por execucao, restrito a identificador SQL seguro. */
export function nomeDescartavel(aleatorio: () => string = () => randomBytes(6).toString('hex')): string {
  const nome = PREFIXO + aleatorio();
  assertIdentificadorSeguro(nome);
  return nome;
}

/**
 * CREATE DATABASE nao aceita parametro vinculado — o nome entra no texto do SQL.
 * Entao o charset e validado antes, e nao depende de o gerador ser confiavel.
 */
export function assertIdentificadorSeguro(nome: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(nome)) {
    throw new VerificacaoFalhou(`Identificador de banco recusado: ${JSON.stringify(nome)}`);
  }
}

/**
 * Monta os argumentos do psql. A senha NAO aparece aqui: `-e PGPASSWORD` sem
 * valor faz o docker encaminhar a variavel do ambiente do processo.
 */
export function argumentosPsql(usuario: string, banco: string, extras: string[] = []): string[] {
  return [
    'compose', '-f', COMPOSE, 'exec', '-T', '-e', 'PGPASSWORD',
    'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', usuario, '-d', banco,
    ...extras,
  ];
}

export function fingerprintEsperado(orderId: string): string {
  return createHash('sha256').update(`v1:${orderId}`).digest('hex');
}

function executorPadrao(args: string[], env: NodeJS.ProcessEnv, entrada?: string): ResultadoDeComando {
  const r = spawnSync('docker', args, { env, input: entrada, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface Contexto {
  executor: Executor;
  env: NodeJS.ProcessEnv;
  usuario: string;
}

function sql(ctx: Contexto, banco: string, texto: string, extras: string[] = []): string {
  const r = ctx.executor(argumentosPsql(ctx.usuario, banco, extras), ctx.env, texto);
  if (r.status !== 0) {
    throw new VerificacaoFalhou(`psql falhou em ${banco}: ${r.stderr.trim().slice(0, 400)}`);
  }
  return r.stdout.trim();
}

function consulta(ctx: Contexto, banco: string, texto: string): string {
  return sql(ctx, banco, texto, ['-tA']);
}

function assertIgual(rotulo: string, obtido: string, esperado: string): void {
  if (obtido !== esperado) {
    throw new VerificacaoFalhou(`${rotulo}: esperava ${JSON.stringify(esperado)}, obtive ${JSON.stringify(obtido)}`);
  }
  console.log(`  ok  ${rotulo}`);
}

const DIR_MIGRATIONS = path.join(RAIZ, 'prisma', 'migrations');

/** So diretorios: a pasta tambem contem migration_lock.toml. */
function pastasDeMigration(): string[] {
  return readdirSync(DIR_MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function migrationsAnteriores(): string[] {
  return pastasDeMigration()
    .filter((d) => !d.includes('fingerprint'))
    .map((d) => path.join(DIR_MIGRATIONS, d, 'migration.sql'));
}

function arquivoDoFingerprint(): string {
  const dir = pastasDeMigration().find((d) => d.includes('fingerprint'));
  if (!dir) throw new VerificacaoFalhou('migration do fingerprint nao encontrada');
  return path.join(DIR_MIGRATIONS, dir, 'migration.sql');
}

const SEMENTE = `
INSERT INTO "payments" (id,"orderId","userId",status,"amountCents",currency,provider,"expiresAt","updatedAt")
VALUES ('pay-a','ord-alpha','usr-1','CAPTURED',12990,'BRL','fake', now() + interval '15 min', now()),
       ('pay-b','ord-beta','usr-1','PROCESSING',5000,'BRL','fake', now() + interval '15 min', now());

INSERT INTO "idempotency_records" (id,"userId",key,"paymentId",status,"updatedAt")
VALUES ('rec-completed','usr-1','chave-concluida','pay-a','COMPLETED', now()),
       ('rec-processing','usr-1','chave-em-voo','pay-b','PROCESSING', now()),
       ('rec-orfa','usr-1','chave-sem-pagamento',NULL,'FAILED', now());
`;

function prepararBanco(ctx: Contexto, banco: string): void {
  assertIdentificadorSeguro(banco);
  // Sem IF EXISTS: se o nome ja existir, e sinal de colisao e a execucao para,
  // em vez de apagar dado de outra pessoa.
  sql(ctx, 'postgres', `CREATE DATABASE ${banco};`);
  for (const arquivo of migrationsAnteriores()) {
    sql(ctx, banco, readFileSync(arquivo, 'utf8'));
  }
  sql(ctx, banco, SEMENTE);
}

function cenarioFeliz(ctx: Contexto, banco: string): void {
  console.log('\ncenario 1 — claims vinculadas sobrevivem, orfa e descartada');
  prepararBanco(ctx, banco);
  // -1: mesma moldura transacional que o Prisma aplica em producao.
  sql(ctx, banco, readFileSync(arquivoDoFingerprint(), 'utf8'), ['-1']);

  assertIgual('total de claims preservadas', consulta(ctx, banco, 'SELECT count(*) FROM "idempotency_records";'), '2');
  assertIgual('claim orfa removida', consulta(ctx, banco, `SELECT count(*) FROM "idempotency_records" WHERE id='rec-orfa';`), '0');
  assertIgual('COMPLETED preservada', consulta(ctx, banco, `SELECT status FROM "idempotency_records" WHERE id='rec-completed';`), 'COMPLETED');
  assertIgual('PROCESSING preservada', consulta(ctx, banco, `SELECT status FROM "idempotency_records" WHERE id='rec-processing';`), 'PROCESSING');
  assertIgual(
    'fingerprint da COMPLETED bate com a receita do servico',
    consulta(ctx, banco, `SELECT "requestFingerprint" FROM "idempotency_records" WHERE id='rec-completed';`),
    fingerprintEsperado('ord-alpha'),
  );
  assertIgual(
    'fingerprint da PROCESSING bate com a receita do servico',
    consulta(ctx, banco, `SELECT "requestFingerprint" FROM "idempotency_records" WHERE id='rec-processing';`),
    fingerprintEsperado('ord-beta'),
  );
  assertIgual(
    'coluna ficou obrigatoria',
    consulta(ctx, banco, `SELECT is_nullable FROM information_schema.columns WHERE table_name='idempotency_records' AND column_name='requestFingerprint';`),
    'NO',
  );
}

function cenarioDeAborto(ctx: Contexto, banco: string): void {
  console.log('\ncenario 2 — precondicao falha e a migration inteira e desfeita');
  prepararBanco(ctx, banco);

  // Cria exatamente o estado que a precondicao existe para pegar: claim com
  // paymentId sem Payment correspondente. So e possivel removendo a FK, que e o
  // que torna esse estado "impossivel" — por isso a precondicao e uma rede de
  // seguranca, nao redundancia.
  sql(ctx, banco, `
ALTER TABLE "idempotency_records" DROP CONSTRAINT "idempotency_records_paymentId_fkey";
INSERT INTO "idempotency_records" (id,"userId",key,"paymentId",status,"updatedAt")
VALUES ('rec-quebrada','usr-1','chave-quebrada','pay-inexistente','COMPLETED', now());
`);

  const r = ctx.executor(
    argumentosPsql(ctx.usuario, banco, ['-1']),
    ctx.env,
    readFileSync(arquivoDoFingerprint(), 'utf8'),
  );

  if (r.status === 0) {
    throw new VerificacaoFalhou('a migration DEVERIA ter abortado, mas terminou com sucesso');
  }
  console.log('  ok  migration abortou');

  assertIgual(
    'coluna NAO foi criada (rollback integral)',
    consulta(ctx, banco, `SELECT count(*) FROM information_schema.columns WHERE table_name='idempotency_records' AND column_name='requestFingerprint';`),
    '0',
  );
  assertIgual(
    'nenhuma claim foi apagada',
    consulta(ctx, banco, 'SELECT count(*) FROM "idempotency_records";'),
    '4',
  );
}

export function verificar(executor: Executor = executorPadrao): number {
  const arquivo = dotenv.parse(readFileSync(path.join(RAIZ, '.env'), 'utf8'));
  const url = new URL(arquivo.DATABASE_URL as string);
  const usuario = url.username;
  // A senha vive SO no env do processo filho.
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: url.password };
  const ctx: Contexto = { executor, env, usuario };

  const bancos: string[] = [];
  try {
    for (const cenario of [cenarioFeliz, cenarioDeAborto]) {
      const banco = nomeDescartavel();
      bancos.push(banco);
      cenario(ctx, banco);
    }
    console.log('\nverificacao concluida: os dois cenarios passaram');
    return 0;
  } catch (erro) {
    console.error(`\nFALHOU: ${(erro as Error).message}`);
    return 1;
  } finally {
    // Remove SOMENTE o que esta execucao criou, mesmo em caso de falha.
    for (const banco of bancos) {
      try {
        sql(ctx, 'postgres', `DROP DATABASE IF EXISTS ${banco};`);
      } catch {
        console.error(`  aviso: banco descartavel ${banco} nao pode ser removido`);
      }
    }
  }
}

if (require.main === module) {
  process.exit(verificar());
}
