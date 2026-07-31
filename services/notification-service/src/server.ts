import dotenv from 'dotenv';
dotenv.config();
import { connect } from './config/connection';
import { EXCHANGE, EXCHANGE_TYPE, QUEUE, BINDING_KEY, DLX, DLQ } from './config/topology';
import { decideMessage, handleEvent, sanitizeForLog } from './consumer';
import { claimEvent } from './idempotency';
import { closeRedis } from './config/redis';

async function start() {
  const connection = await connect();
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });

  // Dead-letter: DLX fanout -> DLQ duravel. Mensagem com nack(false,false) e
  // roteada para a DLQ em vez de sumir.
  await channel.assertExchange(DLX, 'fanout', { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, '');

  // Fila principal com dead-letter. NOTA: args de fila duravel sao imutaveis no
  // RabbitMQ; migrar (adicionar a DLX) exige recriar a fila (migracao one-time:
  // deletar a fila antiga antes de subir). Registrado no TECH_DEBT.
  await channel.assertQueue(QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DLX },
  });
  await channel.bindQueue(QUEUE, EXCHANGE, BINDING_KEY);
  await channel.prefetch(1);

  console.log(
    '[notification] consumindo ' + QUEUE + ' (binding ' + BINDING_KEY + ' no exchange ' + EXCHANGE + '); DLQ: ' + DLQ
  );

  await channel.consume(QUEUE, async (msg) => {
    if (!msg) return;
    const routingKey = msg.fields.routingKey;
    const raw = msg.content.toString();

    const decision = decideMessage(raw, routingKey);
    if (!decision.ack || !decision.event) {
      // Invalido/envenenado -> DLQ (nack sem requeue; DLX roteia).
      console.error(
        '[notification] descartado para DLQ (' + sanitizeForLog(routingKey) + '): ' + decision.reason
      );
      channel.nack(msg, false, false);
      return;
    }

    const event = decision.event;
    try {
      const primeiro = await claimEvent(event.eventId);
      if (!primeiro) {
        // Duplicata: eventId ja reivindicado -> ack e ignora (sem reprocessar).
        console.log('[notification] duplicata ignorada (eventId ' + sanitizeForLog(event.eventId) + ')');
        channel.ack(msg);
        return;
      }
      handleEvent(event);
      channel.ack(msg);
    } catch (err) {
      // Erro no store de idempotencia (ex.: Redis fora) ou no processamento:
      // requeue para tentar de novo — nao perde e nao processa sem dedup.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        '[notification] falha ao processar/dedup ' + sanitizeForLog(routingKey) + ': ' + reason + ' (requeue)'
      );
      channel.nack(msg, false, true);
    }
  });

  // Encerramento gracioso, idempotente.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[notification] ' + signal + ' recebido; encerrando...');
    try {
      await channel.close();
    } catch {
      /* canal ja fechado */
    }
    try {
      await connection.close();
    } catch {
      /* conexao ja fechada */
    }
    await closeRedis();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Queda inesperada: so reinicia (exit 1) se NAO for shutdown intencional.
  connection.on('close', () => {
    if (shuttingDown) return;
    console.error('[notification] conexao fechada; encerrando (exit 1) para reiniciar');
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('[notification] erro fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
