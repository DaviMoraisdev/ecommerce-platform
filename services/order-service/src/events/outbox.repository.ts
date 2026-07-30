import { Prisma, OutboxEvent } from '@prisma/client';
import { prisma } from '../config/database';

export interface OutboxInput {
  eventId: string;
  routingKey: string;
  payload: Prisma.InputJsonValue;
}

// Grava o evento na MESMA transacao do pedido (recebe o tx): estado + evento no
// mesmo commit atomico — ou os dois, ou nenhum.
export async function enqueue(
  tx: Prisma.TransactionClient,
  ev: OutboxInput
): Promise<void> {
  await tx.outboxEvent.create({
    data: { eventId: ev.eventId, routingKey: ev.routingKey, payload: ev.payload },
  });
}

// PENDING mais antigos primeiro; desempate por id para ordem deterministica
// mesmo quando o createdAt (precisao de ms) empata.
export async function fetchPending(limit: number): Promise<OutboxEvent[]> {
  return prisma.outboxEvent.findMany({
    where: { status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

export async function markSent(id: string): Promise<void> {
  await prisma.outboxEvent.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date() },
  });
}

// Falha ao publicar: MANTEM PENDING (retry indefinido — o intervalo do relay e o
// backoff) e registra attempts/lastError so para observabilidade. Nao abandona o
// evento, preservando o at-least-once. Quarentena/redrive de evento "poison"
// fica para 8b-2/Fase 10 (documentado no TECH_DEBT).
export async function markRetry(id: string, error: string): Promise<void> {
  await prisma.outboxEvent.update({
    where: { id },
    data: {
      attempts: { increment: 1 },
      lastError: error.slice(0, 500),
    },
  });
}
