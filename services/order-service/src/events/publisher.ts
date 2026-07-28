import amqp from 'amqplib';
import { EXCHANGE, EXCHANGE_TYPE } from './topology';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpConfirmChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

// Config numerica validada: valores invalidos (NaN/negativo) caem no default.
function toIntInRange(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}
const MAX_RETRIES = toIntInRange(process.env.RABBITMQ_MAX_RETRIES, 5, 1);
const RETRY_DELAY_MS = toIntInRange(process.env.RABBITMQ_RETRY_DELAY_MS, 2000, 0);
const CONNECT_TIMEOUT_MS = toIntInRange(process.env.RABBITMQ_CONNECT_TIMEOUT_MS, 5000, 1);
const PUBLISH_TIMEOUT_MS = toIntInRange(process.env.RABBITMQ_PUBLISH_TIMEOUT_MS, 3000, 1);

let connection: AmqpConnection | null = null;
let channel: AmqpConfirmChannel | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Limita qualquer espera no tempo: se a Promise nao resolver em ms, rejeita.
// Sem isso, um broker que "trava" (sem rejeitar) penduraria o boot ou uma request.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + ms + 'ms: ' + label)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

// Chamado UMA vez no boot (em background). Abre conexao + canal confirm com
// deadline e declara o exchange. So publica o estado global apos sucesso total;
// em falha parcial, fecha a conexao aberta para nao vazar.
export async function initEventPublisher(): Promise<void> {
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    console.warn(
      '[events] RABBITMQ_URL nao definida, publisher desativado (eventos nao serao emitidos)'
    );
    return;
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let conn: AmqpConnection | null = null;
    try {
      conn = await withTimeout(amqp.connect(url), CONNECT_TIMEOUT_MS, 'connect');
      const ch = await conn.createConfirmChannel();
      await ch.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });

      conn.on('error', (err) => {
        console.warn(
          '[events] conexao com erro: ' + (err instanceof Error ? err.message : String(err))
        );
      });
      conn.on('close', () => {
        console.warn('[events] conexao fechada; publisher desativado ate reiniciar o processo');
        connection = null;
        channel = null;
      });

      connection = conn;
      channel = ch;
      console.log('[events] publisher conectado ao RabbitMQ; exchange "' + EXCHANGE + '" pronto');
      return;
    } catch (err) {
      lastErr = err;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[events] init tentativa ' + attempt + '/' + MAX_RETRIES + ' falhou: ' + reason);
      // fecha conexao parcialmente aberta (evita vazamento entre retries)
      if (conn) {
        try {
          await conn.close();
        } catch {
          /* ja caindo */
        }
      }
      connection = null;
      channel = null;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('falha ao conectar ao RabbitMQ');
}

// Publica um evento. BEST-EFFORT com deadline: se o canal estiver indisponivel
// ou a confirmacao nao chegar em PUBLISH_TIMEOUT_MS, apenas registra e retorna —
// nunca pendura o chamador (createOrder ja commitou). Entrega at-most-once.
export async function publishEvent(routingKey: string, payload: object): Promise<void> {
  if (!channel) {
    console.warn('[events] canal indisponivel; evento descartado (' + routingKey + ')');
    return;
  }
  try {
    const body = Buffer.from(JSON.stringify(payload));
    channel.publish(EXCHANGE, routingKey, body, {
      persistent: true,
      contentType: 'application/json',
    });
    await withTimeout(channel.waitForConfirms(), PUBLISH_TIMEOUT_MS, 'confirm ' + routingKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[events] falha ao publicar ' + routingKey + ': ' + reason);
  }
}

export async function closeEventPublisher(): Promise<void> {
  try {
    await channel?.close();
  } catch {
    /* canal ja fechado */
  }
  try {
    await connection?.close();
  } catch {
    /* conexao ja fechada */
  }
  channel = null;
  connection = null;
}
