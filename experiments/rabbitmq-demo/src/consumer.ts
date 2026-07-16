import dotenv from 'dotenv';
dotenv.config();

import { connect } from './connection';
import { EXCHANGE, EXCHANGE_TYPE, QUEUE, BINDING_KEY } from './topology';

async function main() {
  const conn = await connect();
  const channel = await conn.createChannel();

  await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, BINDING_KEY);
  await channel.prefetch(1);

  console.log('[consumer] aguardando em ' + QUEUE + ' (binding ' + BINDING_KEY + ')...');

  await channel.consume(QUEUE, (msg) => {
    if (!msg) return;
    const routingKey = msg.fields.routingKey;
    const raw = msg.content.toString();
    try {
      const event = JSON.parse(raw);
      console.log('[consumer] recebida (' + routingKey + '): ' + JSON.stringify(event));
      // ack so APOS processar com sucesso.
      channel.ack(msg);
    } catch {
      // Payload invalido: nack sem requeue (evita loop). Numa app real iria
      // para uma dead-letter queue.
      console.error('[consumer] payload invalido descartado: ' + raw);
      channel.nack(msg, false, false);
    }
  });
}

main().catch((err) => {
  console.error('[consumer] erro:', err instanceof Error ? err.message : err);
  process.exit(1);
});
