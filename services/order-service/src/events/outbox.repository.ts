import { Prisma, OutboxEvent, OutboxStatus } from '@prisma/client';
import { prisma } from '../config/database';

// Depois de MAX_ATTEMPTS falhas de publicacao, a linha vira FAILED (parkeada
// para inspecao/reconciliacao) em vez de ser retentada para sempre.
const MAX_ATTEMPTS = 10;

export interface OutboxInput {
  eventId: string;
  routingKey: string;
  payload: Prisma.InputJsonValue;
}

// Grava o evento na MESMA transacao do pedido (recebe o tx). Isso e o coracao
// do outbox: estado + evento no mesmo commit atomico — ou os dois, ou nenhum.
export async function enqueue(
  tx: Prisma.TransactionClient,
  ev: OutboxInput
): Promise<void> {
  await tx.outboxEvent.create({
    data: { eventId: ev.eventId, routingKey: ev.routingKey, payload: ev.payload },
  });
}

// PENDING mais antigos primeiro: o relay publica na ordem de criacao.
export async function fetchPending(limit: number): Promise<OutboxEvent[]> {
  return prisma.outboxEvent.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

export async function markSent(id: string): Promise<void> {
  await prisma.outboxEvent.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date() },
  });
}

// Falha ao publicar: incrementa attempts e guarda o erro. Estourou o teto ->
// FAILED (nao trava a fila nem tenta infinitamente).
export async function markRetry(
  id: string,
  currentAttempts: number,
  error: string
): Promise<void> {
  const status: OutboxStatus = currentAttempts + 1 >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
  await prisma.outboxEvent.update({
    where: { id },
    data: {
      attempts: { increment: 1 },
      lastError: error.slice(0, 500),
      status,
    },
  });
}
