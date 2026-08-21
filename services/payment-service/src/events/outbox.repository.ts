import type { Prisma, OutboxEvent } from '@prisma/client';
import { getPrisma } from '../config/database';

export interface OutboxInput {
  eventId: string;
  routingKey: string;
  payload: Prisma.InputJsonValue;
}

/**
 * Recebe o `tx`: o evento e gravado na MESMA transacao do efeito — ou os dois
 * commitam, ou nenhum. E o que impede pagamento capturado sem evento (pedido
 * nunca fica sabendo) e evento sem captura (pedido pago que nao foi).
 */
export async function enqueue(tx: Prisma.TransactionClient, ev: OutboxInput): Promise<void> {
  await tx.outboxEvent.create({
    data: { eventId: ev.eventId, routingKey: ev.routingKey, payload: ev.payload },
  });
}

/** PENDING mais antigos primeiro; desempate por id porque createdAt tem ms. */
export async function fetchPending(limite: number): Promise<OutboxEvent[]> {
  return getPrisma().outboxEvent.findMany({
    where: { status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limite,
  });
}

export async function markSent(id: string): Promise<void> {
  await getPrisma().outboxEvent.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date() },
  });
}

/**
 * Falha ao publicar MANTEM PENDING: abandonar o evento quebraria o
 * at-least-once. `attempts` e `lastError` sao so observabilidade. Teto e
 * quarentena de evento venenoso ficam para o Bloco 6, junto do job.
 */
export async function markRetry(id: string, erro: string): Promise<void> {
  await getPrisma().outboxEvent.update({
    where: { id },
    data: { attempts: { increment: 1 }, lastError: erro.slice(0, 500) },
  });
}
