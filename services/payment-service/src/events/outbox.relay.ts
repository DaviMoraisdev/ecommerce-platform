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

const LOTE_PADRAO = 20;

/** Guarda de reentrada: dois ciclos simultaneos publicariam o mesmo lote. */
let executando = false;

/**
 * Um ciclo. So publica com o publisher pronto; se nao estiver, TENTA reconectar
 * e, falhando, sai SEM TOCAR nos eventos — broker fora e transitorio e nao pode
 * empurrar evento saudavel para a quarentena.
 */
export async function tick(deps: RelayDeps): Promise<void> {
  if (executando) return;
  executando = true;
  try {
    if (!deps.isPublisherReady()) {
      try {
        await deps.initEventPublisher();
      } catch {
        /* broker fora: tenta no proximo ciclo */
      }
    }
    if (!deps.isPublisherReady()) return;

    const pendentes = await deps.fetchPending(deps.lote ?? LOTE_PADRAO);
    for (const ev of pendentes) {
      const ok = await deps.publish(ev.routingKey, ev.payload as object);
      if (ok) {
        await deps.markSent(ev.id);
      } else {
        await deps.markRetry(ev.id, 'publish falhou');
        if (!deps.isPublisherReady()) break; // canal caiu no meio do lote
      }
    }
  } catch (erro) {
    console.error('[relay] ciclo falhou: ' + (erro instanceof Error ? erro.message : String(erro)));
  } finally {
    executando = false;
  }
}
