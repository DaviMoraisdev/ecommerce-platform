import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { PaymentStatus, TransactionStatus, TransactionType, type PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { criarPaymentController } from '../../src/controllers/payment.controller';
import { ROUTING_PAYMENT_REFUNDED } from '../../src/events/topology';
import { criarAuthMiddleware } from '../../src/middlewares/auth.middleware';
import { exigirRole } from '../../src/middlewares/role.middleware';
import { FakeProvider } from '../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../src/providers/fake/fake.tokens';
import { criarPaymentRouter } from '../../src/routes/payment.routes';
import { PaymentService } from '../../src/services/payment.service';
import { SEGREDO_JWT, SEGREDO_WEBHOOK } from '../helpers/config';
import { orderClientFalso, pedidoDeTeste } from '../helpers/prisma-fake';
import { assertTestDatabase } from '../helpers/testDbGuard';

/**
 * COSTURA do reembolso (Bloco 8d). As duas metades ja eram provadas — o dominio
 * contra Postgres (R1-R23) e a rota com servico falso (A1-A12). Nada atravessava
 * router -> auth -> exigirAdmin -> controller -> service -> Postgres -> outbox
 * de uma vez. O que so este arquivo pega: rota registrada no caminho errado,
 * exigirAdmin fora de ordem na cadeia, e divergencia entre STATUS_POR_DESFECHO e
 * os desfechos que o servico produz contra banco real.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  assertTestDatabase(process.env);
  prisma = await connectDatabase(process.env.DATABASE_URL as string);
});

afterEach(async () => {
  await prisma.webhookEvent.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.payment.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});

function montar(opcoes: { reembolsoHabilitado?: boolean } = {}) {
  const userId = randomUUID();
  const orderId = randomUUID();
  const pedido = pedidoDeTeste({ id: orderId, userId });
  const provider = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
  const service = new PaymentService({
    prisma,
    orderClient: orderClientFalso(jest.fn(async () => pedido)),
    provider,
    currency: 'BRL',
    windowMinutes: 15,
  });
  const app = createApp({
    payments: criarPaymentRouter({
      // Tudo REAL: e a cadeia inteira que esta sob teste, nao uma imitacao dela.
      authMiddleware: criarAuthMiddleware(SEGREDO_JWT),
      exigirAdmin: exigirRole('ADMIN'),
      reembolsoHabilitado: opcoes.reembolsoHabilitado ?? true,
      controller: criarPaymentController(service),
    }),
    webhooks: express.Router(),
  });
  return { app, service, userId, orderId };
}

/** Pagamento CAPTURED pelo caminho normal: o FakeProvider precisa conhecer a cobranca. */
async function pagamentoCapturado(ctx: ReturnType<typeof montar>) {
  await ctx.service.criarPagamento({
    userId: ctx.userId,
    authorization: 'Bearer token.do.usuario',
    orderId: ctx.orderId,
    paymentMethodToken: FAKE_TOKENS.SUCCESS,
    idempotencyKey: randomUUID(),
  });
  const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
  expect(payment.status).toBe(PaymentStatus.CAPTURED);
  return payment;
}

function bearer(role?: string): string {
  return 'Bearer ' + jwt.sign({ id: 'adm_1', role }, SEGREDO_JWT, { algorithm: 'HS256' });
}

function reembolsar(app: express.Express, paymentId: string, valorCents: number, opcoes: { token?: string | null; chave?: string } = {}) {
  let req = request(app).post(`/payments/${paymentId}/refunds`);
  if (opcoes.token !== null) req = req.set('Authorization', opcoes.token ?? bearer('ADMIN'));
  return req.set('Idempotency-Key', opcoes.chave ?? randomUUID()).send({ valorCents });
}

async function linhasDeReembolso(paymentId: string) {
  return prisma.paymentTransaction.findMany({ where: { paymentId, type: TransactionType.REFUND } });
}

describe('POST /payments/:id/refunds — costura ate o Postgres', () => {
  it('CASO H1: ADMIN reembolsa e o efeito chega ao banco e a outbox', async () => {
    const ctx = montar();
    const payment = await pagamentoCapturado(ctx);
    const parte = Math.floor(payment.capturedAmountCents / 2);

    const res = await reembolsar(ctx.app, payment.id, parte);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tipo: 'aplicado' });

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(parte);
    const linhas = await linhasDeReembolso(payment.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe(TransactionStatus.SUCCEEDED);
    expect(linhas[0].amountCents).toBe(parte);
    // O evento nasce na MESMA transacao do efeito (7b).
    expect(await prisma.outboxEvent.count({ where: { routingKey: ROUTING_PAYMENT_REFUNDED } })).toBe(1);
  });

  it('CASO H2: replay com a MESMA chave devolve 200 e nao contabiliza de novo', async () => {
    const ctx = montar();
    const payment = await pagamentoCapturado(ctx);
    const parte = Math.floor(payment.capturedAmountCents / 2);
    const chave = randomUUID();

    const primeira = await reembolsar(ctx.app, payment.id, parte, { chave });
    const segunda = await reembolsar(ctx.app, payment.id, parte, { chave });

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(200);
    expect(segunda.body).toMatchObject({ tipo: 'aplicado', replay: true });
    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(parte);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(1);
  });

  it('CASO H3: sem role ADMIN e 403 e o banco nao e tocado', async () => {
    const ctx = montar();
    const payment = await pagamentoCapturado(ctx);

    const res = await reembolsar(ctx.app, payment.id, 100, { token: bearer('USER') });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'ACESSO_NEGADO' });
    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
    expect(await prisma.outboxEvent.count({ where: { routingKey: ROUTING_PAYMENT_REFUNDED } })).toBe(0);
  });

  it('CASO H4: sem token e 401 antes de qualquer autorizacao', async () => {
    const ctx = montar();
    const payment = await pagamentoCapturado(ctx);

    const res = await reembolsar(ctx.app, payment.id, 100, { token: null });

    expect(res.status).toBe(401);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  it('CASO H5: com a flag desligada a rota NAO existe (404, nao 503)', async () => {
    const ctx = montar({ reembolsoHabilitado: false });
    const payment = await pagamentoCapturado(ctx);

    const res = await reembolsar(ctx.app, payment.id, 100);

    expect(res.status).toBe(404);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });
});
