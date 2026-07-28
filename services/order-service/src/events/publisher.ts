import amqp from 'amqplib';
import { EXCHANGE, EXCHANGE_TYPE } from './topology';

// Tipos derivados do retorno da lib: robusto a mudancas de nome entre versoes
// de @types/amqplib (evita depender do nome exportado ChannelModel/Connection).
type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpConfirmChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

const MAX_RETRIES = Number(process.env.RABBITMQ_MAX_RETRIES ?? 5);
const RETRY_DELAY_MS = Number(process.env.RABBITMQ_RETRY_DELAY_MS ?? 2000);

// Conexao e canal de vida longa, reusados por TODAS as publicacoes do processo.
let connection: AmqpConnection | null = null;
let channel: AmqpConfirmChannel | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Chamado UMA vez no boot. Abre conexao + canal confirm e declara o exchange.
// A fila/binding sao declarados pelo CONSUMIDOR (dono da fila), nao aqui.
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
    try {
      connection = await amqp.connect(url);
      channel = await connection.createConfirmChannel();
      await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });

      connection.on('error', (err) => {
        console.warn(
          '[events] conexao com erro: ' + (err instanceof Error ? err.message : String(err))
        );
      });
      connection.on('close', () => {
        console.warn('[events] conexao fechada; publisher desativado ate reiniciar o processo');
        connection = null;
        channel = null;
      });

      console.log('[events] publisher conectado ao RabbitMQ; exchange "' + EXCHANGE + '" pronto');
      return;
    } catch (err) {
      lastErr = err;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[events] init tentativa ' + attempt + '/' + MAX_RETRIES + ' falhou: ' + reason);
      connection = null;
      channel = null;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// Publica um evento. BEST-EFFORT: nunca lanca para o chamador — se o canal
// estiver indisponivel ou a confirmacao falhar, apenas registra e retorna.
// Consequencia: entrega at-most-once (o evento pode se perder). Trade-off
// aceito no 8a; o 8b substitui por outbox transacional (at-least-once).
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
    await channel.waitForConfirms();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[events] falha ao publicar ' + routingKey + ': ' + reason);
  }
}

// Fechamento gracioso (testes/shutdown). Ignora erros de canal ja morto.
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
