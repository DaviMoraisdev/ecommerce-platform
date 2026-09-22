import type { PrismaClient } from '@prisma/client';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { ConflitoDeEventoError, enqueue } from '../../src/events/outbox.repository';
import { assertTestDatabase } from '../helpers/testDbGuard';

/**
 * Bloco 9a-1. O que so o Postgres prova: que a duplicata NAO envenena a
 * transacao (um duble aceitaria qualquer coisa depois de um erro) e que o
 * conflito desfaz a transacao INTEIRA do chamador.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  assertTestDatabase(process.env);
  prisma = await connectDatabase(process.env.DATABASE_URL as string);
});

afterEach(async () => {
  await prisma.outboxEvent.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});

function evento(eventId: string, opcoes: { amountCents?: number; occurredAt?: string; routingKey?: string } = {}) {
  return {
    eventId,
    routingKey: opcoes.routingKey ?? 'payment.captured',
    payload: {
      paymentId: 'pay_1',
      orderId: 'ord_1',
      amountCents: opcoes.amountCents ?? 1000,
      currency: 'BRL',
      occurredAt: opcoes.occurredAt ?? '2026-09-22T10:00:00.000Z',
    },
  };
}

describe('enqueue — idempotencia contra Postgres (Bloco 9a-1)', () => {
  it('O1: o MESMO fato gravado de novo e no-op e NAO envenena a transacao', async () => {
    await prisma.$transaction((tx) => enqueue(tx, evento('payment.captured:pay_1')));

    await prisma.$transaction(async (tx) => {
      await enqueue(tx, evento('payment.captured:pay_1', { occurredAt: '2026-09-22T10:05:00.000Z' }));
      // A prova de que a transacao nao foi envenenada: com create + P2002, esta
      // instrucao receberia "current transaction is aborted".
      await enqueue(tx, evento('payment.expired:pay_2', { routingKey: 'payment.expired' }));
    });

    expect(await prisma.outboxEvent.count()).toBe(2);
    const original = await prisma.outboxEvent.findUniqueOrThrow({ where: { eventId: 'payment.captured:pay_1' } });
    // A primeira gravacao vence: a duplicata nao reescreve nada.
    expect((original.payload as { occurredAt: string }).occurredAt).toBe('2026-09-22T10:00:00.000Z');
  });

  it('O2: mesmo eventId com FATO diferente lanca e desfaz a transacao INTEIRA', async () => {
    await prisma.$transaction((tx) => enqueue(tx, evento('payment.captured:pay_1')));

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueue(tx, evento('payment.expired:pay_2', { routingKey: 'payment.expired' }));
        await enqueue(tx, evento('payment.captured:pay_1', { amountCents: 999 }));
      }),
    ).rejects.toBeInstanceOf(ConflitoDeEventoError);

    // O evento gravado ANTES do conflito, na mesma transacao, foi desfeito junto.
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('O3: mesmo eventId com routing key diferente e conflito', async () => {
    await prisma.$transaction((tx) => enqueue(tx, evento('evt:x')));
    await expect(
      prisma.$transaction((tx) => enqueue(tx, evento('evt:x', { routingKey: 'payment.expired' }))),
    ).rejects.toBeInstanceOf(ConflitoDeEventoError);
  });
});
