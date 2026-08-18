import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

/**
 * Prova a migration do fingerprint contra registros PREEXISTENTES, usando o
 * MESMO executor da implantacao.
 *
 * Historico das recusas em review, porque cada uma virou uma propriedade deste
 * arquivo:
 *
 *   - `eval` sobre DATABASE_URL: nao ha shell aqui; spawnSync com array.
 *   - senha no argv: viaja no env do filho; o docker recebe `-e PGPASSWORD` sem
 *     valor.
 *   - nome fixo de banco: unico por execucao, validado por charset, e
 *     CREATE DATABASE sem IF EXISTS.
 *   - cleanup apagando banco alheio: o nome so entra na lista DEPOIS de o CREATE
 *     confirmar. Registrar antes fazia uma colisao — que deveria apenas
 *     interromper — apagar o banco preexistente.
 *   - consultas informativas: toda expectativa lanca.
 *   - atomicidade provada sob psql -1: os dois cenarios rodam por
 *     `prisma migrate deploy`, o mesmo comando da implantacao. Provar o SQL sob
 *     uma transacao artificial nao prova o caminho real.
 */

const RAIZ = path.resolve(__dirname, '..');
const COMPOSE = path.resolve(RAIZ, '..', '..', 'docker-compose.yml');
const DIR_MIGRATIONS = path.join(RAIZ, 'prisma', 'migrations');
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
  comando: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  entrada?: string,
) => ResultadoDeComando;

export function nomeDescartavel(
  aleatorio: () => string = () => randomBytes(6).toString('hex'),
): string {
  const nome = PREFIXO + aleatorio();
  assertIdentificadorSeguro(nome);
  return nome;
}

/** CREATE DATABASE nao aceita parametro vinculado: o nome entra no texto do SQL. */
export function assertIdentificadorSeguro(nome: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(nome)) {
    throw new VerificacaoFalhou(`Identificador de banco recusado: ${JSON.stringify(nome)}`);
  }
}

/** `-e PGPASSWORD` sem valor: o docker encaminha a variavel do ambiente. */
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

function executorPadrao(
  comando: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  entrada?: string,
): ResultadoDeComando {
  const r = spawnSync(comando, args, { env, input: entrada, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface Contexto {
  executor: Executor;
  env: NodeJS.ProcessEnv;
  usuario: string;
  urlBase: URL;
}

function sql(ctx: Contexto, banco: string, texto: string, extras: string[] = []): string {
  const r = ctx.executor('docker', argumentosPsql(ctx.usuario, banco, extras), ctx.env, texto);
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
    throw new VerificacaoFalhou(
      `${rotulo}: esperava ${JSON.stringify(esperado)}, obtive ${JSON.stringify(obtido)}`,
    );
  }
  console.log(`  ok  ${rotulo}`);
}

function pastasDeMigration(): string[] {
  return readdirSync(DIR_MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function pastaDoFingerprint(): string {
  const dir = pastasDeMigration().find((d) => d.includes('fingerprint'));
  if (!dir) throw new VerificacaoFalhou('migration do fingerprint nao encontrada');
  return dir;
}

/**
 * Arvore temporaria com o schema e SO as migrations anteriores ao fingerprint.
 *
 * Necessaria porque `migrate deploy` aplica tudo que esta pendente de uma vez, e
 * o cenario exige semear registros ENTRE as migrations anteriores e a do
 * fingerprint.
 */
function arvoreParcial(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'verifica-migration-'));
  mkdirSync(path.join(tmp, 'prisma', 'migrations'), { recursive: true });
  cpSync(path.join(RAIZ, 'prisma', 'schema.prisma'), path.join(tmp, 'prisma', 'schema.prisma'));
  cpSync(
    path.join(DIR_MIGRATIONS, 'migration_lock.toml'),
    path.join(tmp, 'prisma', 'migrations', 'migration_lock.toml'),
  );
  for (const dir of pastasDeMigration()) {
    if (dir.includes('fingerprint')) continue;
    cpSync(path.join(DIR_MIGRATIONS, dir), path.join(tmp, 'prisma', 'migrations', dir), {
      recursive: true,
    });
  }
  return tmp;
}

function urlDoBanco(ctx: Contexto, banco: string): string {
  const u = new URL(ctx.urlBase.toString());
  u.pathname = `/${banco}`;
  return u.toString();
}

/** Aplica migrations pendentes com o MESMO comando da implantacao. */
function migrateDeploy(ctx: Contexto, banco: string, tmp: string): ResultadoDeComando {
  return ctx.executor(
    'npx',
    ['prisma', 'migrate', 'deploy', '--schema', path.join(tmp, 'prisma', 'schema.prisma')],
    { ...ctx.env, DATABASE_URL: urlDoBanco(ctx, banco) },
  );
}

function adicionarFingerprint(tmp: string): void {
  const dir = pastaDoFingerprint();
  cpSync(path.join(DIR_MIGRATIONS, dir), path.join(tmp, 'prisma', 'migrations', dir), {
    recursive: true,
  });
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

function prepararBanco(ctx: Contexto, banco: string, tmp: string): void {
  const r = migrateDeploy(ctx, banco, tmp);
  if (r.status !== 0) {
    throw new VerificacaoFalhou(`migrations anteriores falharam: ${r.stderr.slice(0, 400)}`);
  }
  sql(ctx, banco, SEMENTE);
}

function cenarioFeliz(ctx: Contexto, banco: string, tmp: string): void {
  console.log('\ncenario 1 — claims vinculadas sobrevivem, orfa e descartada');
  prepararBanco(ctx, banco, tmp);
  adicionarFingerprint(tmp);

  const r = migrateDeploy(ctx, banco, tmp);
  if (r.status !== 0) {
    throw new VerificacaoFalhou(`migration do fingerprint falhou: ${r.stderr.slice(0, 400)}`);
  }
  console.log('  ok  aplicada por prisma migrate deploy');

  assertIgual('total de claims preservadas', consulta(ctx, banco, 'SELECT count(*) FROM "idempotency_records";'), '2');
  assertIgual('claim orfa removida', consulta(ctx, banco, `SELECT count(*) FROM "idempotency_records" WHERE id='rec-orfa';`), '0');
  assertIgual('COMPLETED preservada', consulta(ctx, banco, `SELECT status FROM "idempotency_records" WHERE id='rec-completed';`), 'COMPLETED');
  assertIgual('PROCESSING preservada', consulta(ctx, banco, `SELECT status FROM "idempotency_records" WHERE id='rec-processing';`), 'PROCESSING');
  assertIgual('fingerprint da COMPLETED', consulta(ctx, banco, `SELECT "requestFingerprint" FROM "idempotency_records" WHERE id='rec-completed';`), fingerprintEsperado('ord-alpha'));
  assertIgual('fingerprint da PROCESSING', consulta(ctx, banco, `SELECT "requestFingerprint" FROM "idempotency_records" WHERE id='rec-processing';`), fingerprintEsperado('ord-beta'));
  assertIgual('coluna ficou obrigatoria', consulta(ctx, banco, `SELECT is_nullable FROM information_schema.columns WHERE table_name='idempotency_records' AND column_name='requestFingerprint';`), 'NO');
}

function cenarioDeAborto(ctx: Contexto, banco: string, tmp: string): void {
  console.log('\ncenario 2 — precondicao falha e o EXECUTOR REAL desfaz tudo');
  prepararBanco(ctx, banco, tmp);

  // Estado que a precondicao existe para pegar. So alcancavel sem a FK — que e
  // o que faz dela rede de seguranca, e nao redundancia.
  sql(ctx, banco, `
ALTER TABLE "idempotency_records" DROP CONSTRAINT "idempotency_records_paymentId_fkey";
INSERT INTO "idempotency_records" (id,"userId",key,"paymentId",status,"updatedAt")
VALUES ('rec-quebrada','usr-1','chave-quebrada','pay-inexistente','COMPLETED', now());
`);

  adicionarFingerprint(tmp);
  const r = migrateDeploy(ctx, banco, tmp);

  if (r.status === 0) {
    throw new VerificacaoFalhou('a migration DEVERIA ter abortado, mas terminou com sucesso');
  }
  console.log('  ok  prisma migrate deploy abortou');

  // Prova que o ROLLBACK vem do executor real, nao de uma transacao que o
  // verificador inventou.
  assertIgual('coluna NAO foi criada', consulta(ctx, banco, `SELECT count(*) FROM information_schema.columns WHERE table_name='idempotency_records' AND column_name='requestFingerprint';`), '0');
  assertIgual('nenhuma claim foi apagada', consulta(ctx, banco, 'SELECT count(*) FROM "idempotency_records";'), '4');
}

export function verificar(executor: Executor = executorPadrao): number {
  const arquivo = dotenv.parse(readFileSync(path.join(RAIZ, '.env'), 'utf8'));
  const urlBase = new URL(arquivo.DATABASE_URL as string);

  // decodeURIComponent: senha com @ ou : precisa vir percent-encoded na URL, e o
  // psql espera o valor cru. Sem isto, a autenticacao falharia com mensagem
  // enganosa.
  const usuario = decodeURIComponent(urlBase.username);
  const senha = decodeURIComponent(urlBase.password);

  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: senha };
  const ctx: Contexto = { executor, env, usuario, urlBase };

  const criados: string[] = [];
  const temporarios: string[] = [];

  try {
    for (const cenario of [cenarioFeliz, cenarioDeAborto]) {
      const banco = nomeDescartavel();

      // O nome entra na lista de limpeza SO depois de o CREATE confirmar.
      // Registrar antes fazia uma colisao apagar o banco preexistente — o
      // oposto exato da propriedade que este script anuncia.
      sql(ctx, 'postgres', `CREATE DATABASE ${banco};`);
      criados.push(banco);

      const tmp = arvoreParcial();
      temporarios.push(tmp);
      cenario(ctx, banco, tmp);
    }
    console.log('\nverificacao concluida: os dois cenarios passaram');
    return 0;
  } catch (erro) {
    console.error(`\nFALHOU: ${(erro as Error).message}`);
    return 1;
  } finally {
    for (const banco of criados) {
      try {
        sql(ctx, 'postgres', `DROP DATABASE IF EXISTS ${banco};`);
      } catch {
        console.error(`  aviso: banco descartavel ${banco} nao pode ser removido`);
      }
    }
    for (const tmp of temporarios) {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  process.exit(verificar());
}
