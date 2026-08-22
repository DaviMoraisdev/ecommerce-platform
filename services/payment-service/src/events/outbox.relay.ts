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

/**
 * Faixa fechada, mesmo criterio do relay do order-service. Lido no import: e
 * knob de operacao, sem relevancia de seguranca e com default seguro.
 *
 * Estava DOCUMENTADO no .env.example e nunca lido — operador configurava e nada
 * mudava (apontado no review do PR #54).
 */
function inteiroNaFaixa(raw: string | undefined, padrao: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}

const LOTE_PADRAO = inteiroNaFaixa(process.env.OUTBOX_BATCH, 20, 1, 500);

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

const POLL_INTERVAL_MS = inteiroNaFaixa(process.env.OUTBOX_POLL_INTERVAL_MS, 1000, 50, 60000);
const STOP_TIMEOUT_MS = inteiroNaFaixa(process.env.OUTBOX_STOP_TIMEOUT_MS, 5000, 1, 60000);

let timer: NodeJS.Timeout | null = null;
let parado = false;
let iniciado = false;
let cicloAtual: Promise<void> | null = null;

/** Idempotente: chamar duas vezes nao cria dois loops de timer. */
export function startOutboxRelay(deps: RelayDeps): void {
  if (iniciado) return;
  iniciado = true;
  parado = false;

  const loop = async (): Promise<void> => {
    if (parado) return;
    cicloAtual = tick(deps);
    await cicloAtual;
    cicloAtual = null;
    if (!parado) timer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
  };

  console.log('[relay] outbox relay iniciado (intervalo ' + POLL_INTERVAL_MS + 'ms)');
  void loop();
}

/**
 * Para e AGUARDA o ciclo em voo, para nao encerrar no meio de uma publicacao.
 * Com teto: um tick travado nao pode pendurar o shutdown — o evento fica
 * PENDING e sai no proximo boot, que e o at-least-once funcionando.
 */
export async function stopOutboxRelay(): Promise<void> {
  parado = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (cicloAtual) {
    let idDoTeto: NodeJS.Timeout | undefined;
    const teto = new Promise<void>((resolve) => {
      idDoTeto = setTimeout(() => {
        console.warn(
          '[relay] ciclo nao terminou em ' + STOP_TIMEOUT_MS + 'ms; seguindo o shutdown (evento fica PENDING)',
        );
        resolve();
      }, STOP_TIMEOUT_MS);
    });
    try {
      await Promise.race([cicloAtual.catch(() => undefined), teto]);
    } finally {
      if (idDoTeto) clearTimeout(idDoTeto);
    }
  }
  iniciado = false;
}
