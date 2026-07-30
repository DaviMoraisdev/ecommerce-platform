import amqp from 'amqplib';
import { EXCHANGE, EXCHANGE_TYPE } from './topology';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpConfirmChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

// Config numerica validada com MIN e MAX: fora da faixa -> default.
function toIntInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
const MAX_RETRIES = toIntInRange(process.env.RABBITMQ_MAX_RETRIES, 5, 1, 100);
const RETRY_DELAY_MS = toIntInRange(process.env.RABBITMQ_RETRY_DELAY_MS, 2000, 0, 300000);
const CONNECT_TIMEOUT_MS = toIntInRange(process.env.RABBITMQ_CONNECT_TIMEOUT_MS, 5000, 1, 300000);
const PUBLISH_TIMEOUT_MS = toIntInRange(process.env.RABBITMQ_PUBLISH_TIMEOUT_MS, 3000, 1, 300000);
const CLOSE_TIMEOUT_MS = toIntInRange(process.env.RABBITMQ_CLOSE_TIMEOUT_MS, 3000, 1, 60000);

let connection: AmqpConnection | null = null;
let channel: AmqpConfirmChannel | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Limita a espera no tempo. Se a Promise resolver DEPOIS do timeout, chama
// onLate(v) para o chamador limpar o recurso tardio (ex.: fechar a conexao).
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onLate?: (v: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('timeout ' + ms + 'ms: ' + label));
    }, ms);
    p.then(
      (v) => {
        if (settled) {
          if (onLate) onLate(v);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

// Fecha um recurso com deadline, engolindo erro/trava: um broker travado nao
// pode pendurar o shutdown nem o descarte de um recurso quebrado.
async function closeQuietly(resource: { close(): Promise<void> } | null): Promise<void> {
  if (!resource) return;
  try {
    await withTimeout(Promise.resolve(resource.close()), CLOSE_TIMEOUT_MS, 'close');
  } catch {
    /* fechamento travou ou falhou: segue */
  }
}

let connecting: Promise<void> | null = null;

// Single-flight: chamadas concorrentes (boot + relay) compartilham a MESMA
// conexao em andamento, evitando duas conexoes AMQP em corrida.
export function initEventPublisher(): Promise<void> {
  if (connecting) return connecting;
  connecting = doInitEventPublisher().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function doInitEventPublisher(): Promise<void> {
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
      // Se a conexao chegar tarde (apos o timeout), o onLate a fecha (nao vaza).
      conn = await withTimeout(amqp.connect(url), CONNECT_TIMEOUT_MS, 'connect', (late) => {
        console.warn('[events] conexao tardia (pos-timeout) descartada e fechada');
        void closeQuietly(late);
      });
      const ch = await conn.createConfirmChannel();
      await ch.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });

      conn.on('error', (err) => {
        console.warn(
          '[events] conexao com erro: ' + (err instanceof Error ? err.message : String(err))
        );
      });
      conn.on('close', () => {
        if (connection !== conn) return; // conexao antiga: nao mexe no estado atual
        console.warn('[events] conexao fechada; publisher desativado');
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
      await closeQuietly(conn); // fecha o que abriu nesta tentativa (com deadline)
      connection = null;
      channel = null;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('falha ao conectar ao RabbitMQ');
}

// Circuit-breaker: tira o canal quebrado do estado global e o fecha em
// background. Evita reusar um canal que ja excedeu o deadline de confirmacao.
// Canal quebrado: derruba canal E conexao (evita vazar a conexao no reconnect) e
// zera o estado, para o proximo ciclo reconectar limpo.
function disableChannel(broken: AmqpConfirmChannel): void {
  if (channel === broken) {
    channel = null;
    const conn = connection;
    connection = null;
    void closeQuietly(conn);
  }
  void closeQuietly(broken);
}


export function isPublisherReady(): boolean {
  return channel !== null;
}

// Publica com confirmacao e deadline. Retorna true se confirmado; false se
// falhou (canal indisponivel, erro ou timeout), desativando o canal quebrado.
// Nao lanca: o chamador (relay) decide o retry pelo resultado.
export async function publish(routingKey: string, payload: object): Promise<boolean> {
  const ch = channel;
  if (!ch) return false;
  try {
    const body = Buffer.from(JSON.stringify(payload));
    ch.publish(EXCHANGE, routingKey, body, {
      persistent: true,
      contentType: 'application/json',
    });
    await withTimeout(ch.waitForConfirms(), PUBLISH_TIMEOUT_MS, 'confirm ' + routingKey);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      '[events] falha ao publicar ' + routingKey + ': ' + reason + ' (canal desativado)'
    );
    disableChannel(ch);
    return false;
  }
}

export async function closeEventPublisher(): Promise<void> {
  const ch = channel;
  const conn = connection;
  channel = null;
  connection = null;
  await closeQuietly(ch);
  await closeQuietly(conn);
}
