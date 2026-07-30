import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';
import {
  enqueue,
  fetchPending,
  markSent,
  markRetry,
} from '../src/events/outbox.repository';

beforeAll(() => assertTestDatabase());
beforeEach(async () => {
  await prisma.outboxEvent.deleteMany();
});
afterEach(async () => {
  await prisma.outboxEvent.deleteMany();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('outbox.repository', () => {
  it('enqueue grava PENDING dentro de uma transacao', async () => {
    await prisma.$transaction(async (tx) => {
      await enqueue(tx, { eventId: 'e1', routingKey: 'order.created', payload: { a: 1 } });
    });
    const rows = await prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].eventId).toBe('e1');
  });

  it('fetchPending retorna os mais antigos primeiro', async () => {
    await prisma.$transaction(async (tx) => {
      await enqueue(tx, { eventId: 'a', routingKey: 'order.created', payload: {} });
    });
    await new Promise((r) => setTimeout(r, 10));
    await prisma.$transaction(async (tx) => {
      await enqueue(tx, { eventId: 'b', routingKey: 'order.created', payload: {} });
    });
    const pend = await fetchPending(10);
    expect(pend.map((r) => r.eventId)).toEqual(['a', 'b']);
  });

  it('markSent marca SENT com sentAt', async () => {
    await prisma.$transaction(async (tx) => {
      await enqueue(tx, { eventId: 'e1', routingKey: 'order.created', payload: {} });
    });
    const [row] = await fetchPending(1);
    await markSent(row.id);
    const upd = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(upd.status).toBe('SENT');
    expect(upd.sentAt).not.toBeNull();
  });

  it('markRetry incrementa attempts e vira FAILED no teto', async () => {
    await prisma.$transaction(async (tx) => {
      await enqueue(tx, { eventId: 'e1', routingKey: 'order.created', payload: {} });
    });
    const [row] = await fetchPending(1);
    await markRetry(row.id, 0, 'erro x');
    let r = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(r.attempts).toBe(1);
    expect(r.status).toBe('PENDING');
    expect(r.lastError).toBe('erro x');

    await markRetry(row.id, 9, 'erro final');
    r = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(r.status).toBe('FAILED');
  });
});
