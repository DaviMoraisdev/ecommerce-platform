import dotenv from 'dotenv';
dotenv.config();

import { connect } from './connection';

const EXCHANGE = 'orders';
const EXCHANGE_TYPE = 'topic';
const ROUTING_KEY = 'order.created';

async function main() {
  const conn = await connect();
  // Confirm channel: permite esperar o broker confirmar o recebimento.
  const channel = await conn.createConfirmChannel();

  await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });

  const event = {
    type: 'order.created',
    orderId: 'demo-' + Date.now(),
    total: 100,
    at: new Date().toISOString(),
  };
  const payload = Buffer.from(JSON.stringify(event));

  // Publica na EXCHANGE com a routing key (nunca direto numa fila).
  // persistent: a mensagem sobrevive a restart do broker.
  channel.publish(EXCHANGE, ROUTING_KEY, payload, { persistent: true });
  // Espera a confirmacao antes de fechar (senao a mensagem pode se perder no buffer).
  await channel.waitForConfirms();

  console.log('[publisher] publicado em ' + EXCHANGE + ' (' + ROUTING_KEY + '): ' + JSON.stringify(event));

  await channel.close();
  await conn.close();
}

main().catch((err) => {
  console.error('[publisher] erro:', err.message);
  process.exit(1);
});
