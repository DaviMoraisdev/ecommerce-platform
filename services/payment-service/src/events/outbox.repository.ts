import type { Prisma, OutboxEvent } from '@prisma/client';

export interface OutboxInput {
  eventId: string;
  routingKey: string;
  payload: Prisma.InputJsonValue;
}

/** STUB do Bloco 5a. */
export async function enqueue(tx: Prisma.TransactionClient, ev: OutboxInput): Promise<void> {
  void tx;
  void ev;
  throw new Error('outbox.enqueue: nao implementado (Bloco 5a)');
}

export async function fetchPending(limit: number): Promise<OutboxEvent[]> {
  void limit;
  throw new Error('outbox.fetchPending: nao implementado (Bloco 5a)');
}

export async function markSent(id: string): Promise<void> {
  void id;
  throw new Error('outbox.markSent: nao implementado (Bloco 5a)');
}

export async function markRetry(id: string, erro: string): Promise<void> {
  void id;
  void erro;
  throw new Error('outbox.markRetry: nao implementado (Bloco 5a)');
}
