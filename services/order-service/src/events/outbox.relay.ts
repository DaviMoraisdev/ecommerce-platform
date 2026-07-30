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
let started = false;
let currentTick: Promise<void> | null = null;

// Um ciclo. So publica se o publisher estiver pronto; se nao, TENTA reconectar e,
// se ainda falhar, SAI sem tocar nos eventos (broker fora = transitorio, nao
// penaliza). Falha por publicacao mantem o evento PENDING (markRetry).
export async function tick(): Promise<void> {
  if (running) return;
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
        await outbox.markRetry(ev.id, 'publish falhou');
        if (!isPublisherReady()) break; // canal caiu no meio do lote: retoma depois
      }
    }
  } catch (err) {
    console.error('[relay] ciclo falhou: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    running = false;
  }
}

export function startOutboxRelay(): void {
  if (started) return; // idempotente: nao cria loops/timers duplicados
  started = true;
  stopped = false;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    currentTick = tick();
    await currentTick;
    currentTick = null;
    if (!stopped) timer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
  };
  console.log('[relay] outbox relay iniciado (intervalo ' + POLL_INTERVAL_MS + 'ms, lote ' + BATCH + ')');
  void loop();
}

// Para o relay e AGUARDA o ciclo em andamento terminar, para nao encerrar no meio
// de uma publicacao/atualizacao de estado.
export async function stopOutboxRelay(): Promise<void> {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (currentTick) {
    try {
      await currentTick;
    } catch {
      /* erro do ciclo ja foi logado */
    }
  }
  started = false;
}
