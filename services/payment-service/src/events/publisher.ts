import amqp from 'amqplib';
import { EXCHANGE, EXCHANGE_TYPE } from './topology';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpConfirmChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

/**
 * Copia deliberada do publisher do order-service. A duplicacao do contrato de
 * mensageria ja e decisao registrada (TECH_DEBT, Fase 10) — reescrever do zero
 * um componente ja revisado seria pior que duplicar.
 *
 * UNICA divergencia: a URL vem por PARAMETRO, do loadConfig, em vez de
 * process.env. O payment valida ambiente num lugar so e falha fechado em
 * producao; ler a env aqui criaria uma segunda convencao dentro do servico.
 *
 * Os knobs de tuning abaixo continuam vindo da env com faixa fechada: nao sao
 * relevantes para seguranca e tem default seguro, entao nao justificam inchar
 * o AppConfig com oito campos.
 */
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
// onLate(v) para o chamador limpar o recurso tardio.
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onLate?: (v: T) => void,
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
      },
    );
  });
}

// Fecha com deadline, engolindo erro: broker travado nao pendura o shutdown.
async function closeQuietly(resource: { close(): Promise<void> } | null): Promise<void> {
  if (!resource) return;
  try {
    await withTimeout(Promise.resolve(resource.close()), CLOSE_TIMEOUT_MS, 'close');
  } catch {
    /* fechamento travou ou falhou: segue */
  }
}

let connecting: Promise<void> | null = null;

// Single-flight: chamadas concorrentes compartilham a MESMA conexao em
// andamento, evitando duas conexoes AMQP em corrida.
export function initEventPublisher(url: string): Promise<void> {
  if (connecting) return connecting;
  connecting = doInitEventPublisher(url).finally(() => {
    connecting = null;
  });
  return connecting;
}

async function doInitEventPublisher(url: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let conn: AmqpConnection | null = null;
    try {
      conn = await withTimeout(amqp.connect(url), CONNECT_TIMEOUT_MS, 'connect', (late) => {
        console.warn('[events] conexao tardia (pos-timeout) descartada e fechada');
        void closeQuietly(late);
      });
      const ch = await conn.createConfirmChannel();
      await ch.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });

      conn.on('error', (err) => {
        console.warn(
          '[events] conexao com erro: ' + (err instanceof Error ? err.message : String(err)),
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
      console.log('[events] publisher conectado; exchange "' + EXCHANGE + '" pronto');
      return;
    } catch (err) {
      lastErr = err;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[events] init tentativa ' + attempt + '/' + MAX_RETRIES + ' falhou: ' + reason);
      await closeQuietly(conn);
      connection = null;
      channel = null;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('falha ao conectar ao RabbitMQ');
}

// Canal quebrado: derruba canal E conexao e zera o estado, para o proximo
// ciclo reconectar limpo.
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

// Publica com confirmacao e deadline. NAO lanca: quem decide o retry e o relay.
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
      '[events] falha ao publicar ' + routingKey + ': ' + reason + ' (canal desativado)',
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
