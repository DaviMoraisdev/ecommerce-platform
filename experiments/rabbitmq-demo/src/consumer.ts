import dotenv from 'dotenv';
dotenv.config();

import { connect } from './connection';

const EXCHANGE = 'orders';
const EXCHANGE_TYPE = 'topic';
const QUEUE = 'orders.demo';
const BINDING_KEY = 'order.*';

async function main() {
  const conn = await connect();
  const channel = await conn.createChannel();

  // Exchange, fila e binding sao idempotentes (assert = cria se nao existe).
  await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, BINDING_KEY);

  // prefetch 1: nao entrega nova mensagem antes do ack da anterior.
  await channel.prefetch(1);

  console.log('[consumer] aguardando em ' + QUEUE + ' (binding ' + BINDING_KEY + ')...');

  await channel.consume(QUEUE, (msg) => {
    if (!msg) return;
    const routingKey = msg.fields.routingKey;
    const content = msg.content.toString();
    console.log('[consumer] recebida (' + routingKey + '): ' + content);
    // ack: confirma o processamento; o broker remove a mensagem da fila.
    channel.ack(msg);
  });
}

main().catch((err) => {
  console.error('[consumer] erro:', err.message);
  process.exit(1);
});
