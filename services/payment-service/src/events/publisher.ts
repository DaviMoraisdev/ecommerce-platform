import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { EXCHANGE, EXCHANGE_TYPE } from './topology';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpConfirmChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

/**
 * Derivado do publisher do order-service. A duplicacao do contrato de
 * mensageria ja e decisao registrada (TECH_DEBT, Fase 10).
 *
 * Divergencias em relacao a origem, todas nascidas de review:
 *  - a URL vem por PARAMETRO (loadConfig), nao de process.env;
 *  - publicacao com mandatory + basic.return: confirm nao prova roteamento;
 *  - deadline unico sobre connect + createConfirmChannel + assertExchange;
 *  - listeners no CANAL, nao so na conexao;
 *  - guarda de shutdown: init tardia nao ressuscita publisher fechado;
 *  - credencial redigida em todo log.
 *
 * Os knobs de tuning vem da env com faixa fechada: nao sao relevantes para
 * seguranca e tem default seguro, entao nao justificam inchar o AppConfig.
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
let connecting: Promise<void> | null = null;
let fechado = false;

// messageIds devolvidos pelo broker (basic.return) e ainda nao reconciliados
// pelo publish correspondente. Entra no return, sai no finally do publish.
const naoRoteadas = new Set<string>();

// Erro de shutdown nao e falha de infra: nao deve consumir tentativa de retry.
class PublisherFechado extends Error {}

// A URL do broker carrega a senha e aparece dentro de err.message. Redacao por
// token em vez de regex: regex sobre input nao controlado e superficie de
// ReDoS e sempre deixa um caso escapar.
function motivoSeguro(err: unknown): string {
  const bruto = err instanceof Error ? err.message : String(err);
  return bruto
    .split(' ')
    .map((parte) => (parte.includes('://') ? '[uri redigida]' : parte))
    .join(' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Limita a espera no tempo. A promise abandonada continua com handler de
// rejeicao registrado aqui: sem isso, uma falha tardia viraria unhandled
// rejection e derrubaria o processo.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('timeout ' + ms + 'ms: ' + label));
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
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

// Recursos parcialmente abertos. Precisam ser visiveis de fora da abertura
// porque o deadline pode estourar no meio dela, e o que ja abriu tem de ser
// fechado em vez de vazar.
interface RecursosEmAbertura {
  conn: AmqpConnection | null;
  ch: AmqpConfirmChannel | null;
  abortado: boolean;
}

async function abrirCanal(url: string, ref: RecursosEmAbertura): Promise<AmqpConfirmChannel> {
  const conn = await amqp.connect(url);
  ref.conn = conn;
  if (ref.abortado) throw new Error('abertura abortada');
  const ch = await conn.createConfirmChannel();
  ref.ch = ch;
  if (ref.abortado) throw new Error('abertura abortada');
  await ch.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });
  return ch;
}

async function descartar(ref: RecursosEmAbertura): Promise<void> {
  ref.abortado = true;
  await closeQuietly(ref.ch);
  await closeQuietly(ref.conn);
  ref.ch = null;
  ref.conn = null;
}

function ligarObservadores(conn: AmqpConnection, ch: AmqpConfirmChannel): void {
  conn.on('error', (err) => {
    console.warn('[events] conexao com erro: ' + motivoSeguro(err));
  });
  conn.on('close', () => {
    if (connection !== conn) return; // conexao antiga: nao mexe no estado atual
    console.warn('[events] conexao fechada; publisher desativado');
    connection = null;
    channel = null;
  });

  // Canal e EventEmitter: sem listener de error, o evento vira uncaught
  // exception e mata o processo inteiro por causa de um canal quebrado.
  ch.on('error', (err) => {
    console.warn('[events] canal com erro: ' + motivoSeguro(err));
    desativarCanal(ch);
  });
  ch.on('close', () => {
    if (channel !== ch) return;
    console.warn('[events] canal fechado; publisher desativado');
    channel = null;
  });

  // basic.return: o broker aceitou no exchange mas nenhuma fila casou com a
  // routing key. Chega ANTES do confirm, por protocolo.
  ch.on('return', (msg) => {
    const id = (msg as { properties?: { messageId?: string } } | null)?.properties?.messageId;
    if (typeof id === 'string') naoRoteadas.add(id);
  });
}

// Canal quebrado: derruba canal E conexao e zera o estado, para o proximo
// ciclo reconectar limpo.
function desativarCanal(broken: AmqpConfirmChannel): void {
  if (channel === broken) {
    channel = null;
    const conn = connection;
    connection = null;
    void closeQuietly(conn);
  }
  void closeQuietly(broken);
}

// Single-flight: chamadas concorrentes compartilham a MESMA conexao em
// andamento, evitando duas conexoes AMQP em corrida.
export function initEventPublisher(url: string): Promise<void> {
  fechado = false;
  if (connecting) return connecting;
  connecting = doInitEventPublisher(url).finally(() => {
    connecting = null;
  });
  return connecting;
}

async function doInitEventPublisher(url: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ref: RecursosEmAbertura = { conn: null, ch: null, abortado: false };
    try {
      if (fechado) throw new PublisherFechado('publisher fechado antes da inicializacao');

      // Deadline sobre a abertura INTEIRA. So o connect ter timeout deixava
      // connecting preenchido para sempre se o canal pendurasse, e o
      // single-flight fazia todo tick futuro do relay esperar por ele.
      const ch = await withTimeout(abrirCanal(url, ref), CONNECT_TIMEOUT_MS, 'init do publisher');

      // O shutdown pode ter corrido enquanto a abertura estava em voo.
      // Publicar estado agora ressuscitaria um publisher ja encerrado.
      if (fechado) {
        await descartar(ref);
        throw new PublisherFechado('publisher fechado durante a inicializacao');
      }

      ligarObservadores(ref.conn as AmqpConnection, ch);
      connection = ref.conn;
      channel = ch;
      console.log('[events] publisher conectado; exchange "' + EXCHANGE + '" pronto');
      return;
    } catch (err) {
      if (err instanceof PublisherFechado) throw err;
      lastErr = err;
      console.warn(
        '[events] init tentativa ' + attempt + '/' + MAX_RETRIES + ' falhou: ' + motivoSeguro(err),
      );
      await descartar(ref);
      connection = null;
      channel = null;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  // Reembrulha sanitizado: quem chamar vai logar esta mensagem.
  throw new Error(
    lastErr === undefined ? 'falha ao conectar ao RabbitMQ' : motivoSeguro(lastErr),
  );
}

export function isPublisherReady(): boolean {
  return channel !== null;
}

// Publica com confirmacao e deadline. NAO lanca: quem decide o retry e o relay.
export async function publish(routingKey: string, payload: object): Promise<boolean> {
  const ch = channel;
  if (!ch) return false;
  const messageId = randomUUID();
  try {
    const body = Buffer.from(JSON.stringify(payload));
    ch.publish(EXCHANGE, routingKey, body, {
      persistent: true,
      mandatory: true,
      messageId,
      contentType: 'application/json',
    });
    await withTimeout(ch.waitForConfirms(), PUBLISH_TIMEOUT_MS, 'confirm ' + routingKey);

    // Confirm prova que o BROKER aceitou, nao que uma fila recebeu. Sem esta
    // checagem o relay marcaria SENT uma mensagem descartada em silencio.
    if (naoRoteadas.has(messageId)) {
      console.error(
        '[events] ' +
          routingKey +
          ' aceito pelo broker mas SEM fila ligada (basic.return); mantido pendente',
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      '[events] falha ao publicar ' + routingKey + ': ' + motivoSeguro(err) + ' (canal desativado)',
    );
    desativarCanal(ch);
    return false;
  } finally {
    naoRoteadas.delete(messageId);
  }
}

export async function closeEventPublisher(): Promise<void> {
  fechado = true;
  const ch = channel;
  const conn = connection;
  channel = null;
  connection = null;
  naoRoteadas.clear();
  await closeQuietly(ch);
  await closeQuietly(conn);
}
