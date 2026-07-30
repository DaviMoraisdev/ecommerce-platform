import * as outbox from './outbox.repository';
import { publish, isPublisherReady, initEventPublisher } from './publisher';

function toIntInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
const POLL_INTERVAL_MS = toIntInRange(process.env.OUTBOX_POLL_INTERVAL_MS, 1000, 50, 60000);
const BATCH = toIntInRange(process.env.OUTBOX_BATCH, 20, 1, 500);

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let running = false;

// Um ciclo do relay. So publica se o publisher estiver conectado; se nao
// estiver, TENTA reconectar e, se ainda falhar, SAI sem penalizar os eventos
// (falha transitoria de infra != mensagem ruim). Isso paga a divida de
// auto-reconnect e distingue transitorio de permanente.
export async function tick(): Promise<void> {
  if (running) return; // evita sobreposicao se um ciclo demorar mais que o intervalo
  running = true;
  try {
    if (!isPublisherReady()) {
      try {
        await initEventPublisher();
      } catch {
        /* broker fora: tenta no proximo ciclo */
      }
    }
    if (!isPublisherReady()) return;

    const pendentes = await outbox.fetchPending(BATCH);
    for (const ev of pendentes) {
      const ok = await publish(ev.routingKey, ev.payload as object);
      if (ok) {
        await outbox.markSent(ev.id);
      } else {
        await outbox.markRetry(ev.id, ev.attempts, 'publish falhou');
        // Canal caiu no meio do lote: retoma no proximo ciclo (nao penaliza o resto).
        if (!isPublisherReady()) break;
      }
    }
  } catch (err) {
    console.error('[relay] ciclo falhou: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    running = false;
  }
}

export function startOutboxRelay(): void {
  stopped = false;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await tick();
    if (!stopped) timer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
  };
  console.log('[relay] outbox relay iniciado (intervalo ' + POLL_INTERVAL_MS + 'ms, lote ' + BATCH + ')');
  void loop();
}

export function stopOutboxRelay(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
