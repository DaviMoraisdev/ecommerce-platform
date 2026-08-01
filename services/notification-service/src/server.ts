import dotenv from 'dotenv';
dotenv.config();
import { connect } from './config/connection';
import { EXCHANGE, EXCHANGE_TYPE, QUEUE, BINDING_KEY, DLX, DLQ } from './config/topology';
import { handleDelivery, handleEvent, sanitizeForLog } from './consumer';
import { claimEvent, releaseEvent } from './idempotency';
import { closeRedis } from './config/redis';

const REQUEUE_DELAY_MS = (() => {
  const n = Number(process.env.REQUEUE_DELAY_MS);
  return Number.isInteger(n) && n >= 0 && n <= 60000 ? n : 1000;
})();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function start() {
  const connection = await connect();
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });

  // Dead-letter: DLX fanout -> DLQ duravel.
  await channel.assertExchange(DLX, 'fanout', { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, '');

  // Fila principal com dead-letter. NOTA: args de fila duravel sao imutaveis;
  // adicionar a DLX exige recriar a fila (migracao one-time). Ver TECH_DEBT.
  await channel.assertQueue(QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DLX },
  });
  await channel.bindQueue(QUEUE, EXCHANGE, BINDING_KEY);
  await channel.prefetch(1);

  console.log(
    '[notification] consumindo ' + QUEUE + ' (binding ' + BINDING_KEY + ' no exchange ' + EXCHANGE + '); DLQ: ' + DLQ
  );

  const deps = { claim: claimEvent, release: releaseEvent, handle: handleEvent };

  await channel.consume(QUEUE, async (msg) => {
    if (!msg) return;
    const routingKey = msg.fields.routingKey;
    const raw = msg.content.toString();

    let action;
    try {
      action = await handleDelivery(raw, routingKey, deps);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[notification] erro inesperado (' + sanitizeForLog(routingKey) + '): ' + reason);
      action = { type: 'nack-requeue', reason } as const;
    }

    if (action.type === 'ack') {
      if (action.reason === 'duplicate') {
        console.log('[notification] duplicata ignorada (' + sanitizeForLog(routingKey) + ')');
      }
      channel.ack(msg);
      return;
    }
    if (action.type === 'nack-dlq') {
      console.error('[notification] descartado para DLQ (' + sanitizeForLog(routingKey) + '): ' + action.reason);
      channel.nack(msg, false, false);
      return;
    }
    // nack-requeue: atraso para nao entrar em hot loop enquanto a dependencia se recupera.
    console.warn('[notification] requeue (' + sanitizeForLog(routingKey) + '): ' + action.reason);
    await sleep(REQUEUE_DELAY_MS);
    channel.nack(msg, false, true);
  });

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
