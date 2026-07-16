import dotenv from 'dotenv';
dotenv.config();

import { connect } from './connection';
import { EXCHANGE, EXCHANGE_TYPE, QUEUE, BINDING_KEY } from './topology';

const ROUTING_KEY = 'order.created';

async function main() {
  const conn = await connect();
  const channel = await conn.createConfirmChannel();

  // Declara a topologia COMPLETA antes de publicar: assim a mensagem e
  // roteavel mesmo se o consumer ainda nao subiu — a fila duravel a retem.
  await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, BINDING_KEY);

  const event = {
    type: 'order.created',
    orderId: 'demo-' + Date.now(),
    total: 100,
    at: new Date().toISOString(),
  };

  channel.publish(EXCHANGE, ROUTING_KEY, Buffer.from(JSON.stringify(event)), {
    persistent: true,
  });
  await channel.waitForConfirms();

  console.log(
    '[publisher] publicado em ' + EXCHANGE + ' (' + ROUTING_KEY + '): ' + JSON.stringify(event)
  );
  await channel.close();
  await conn.close();
}

main().catch((err) => {
  console.error('[publisher] erro:', err instanceof Error ? err.message : err);
  process.exit(1);
});
