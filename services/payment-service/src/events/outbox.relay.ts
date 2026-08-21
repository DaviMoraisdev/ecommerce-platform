import type { OutboxEvent } from '@prisma/client';

/**
 * Dependencias INJETADAS, diferente do relay do order-service, que importa os
 * modulos direto. O payment injeta em tudo (bootstrap, encerrar, PaymentService,
 * WebhookService) e e o que torna o ciclo testavel sem broker nem banco.
 */
export interface RelayDeps {
  isPublisherReady: () => boolean;
  initEventPublisher: () => Promise<void>;
  publish: (routingKey: string, payload: object) => Promise<boolean>;
  fetchPending: (limite: number) => Promise<OutboxEvent[]>;
  markSent: (id: string) => Promise<void>;
  markRetry: (id: string, erro: string) => Promise<void>;
  lote?: number;
}

/** STUB do Bloco 5a. */
export async function tick(deps: RelayDeps): Promise<void> {
  void deps;
  throw new Error('tick: nao implementado (Bloco 5a)');
}
