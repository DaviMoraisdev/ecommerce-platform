import dotenv from 'dotenv';
dotenv.config();

import { connect } from './connection';
import { EXCHANGE, EXCHANGE_TYPE, QUEUE, BINDING_KEY } from './topology';

// Remove caracteres de controle (evita injecao no terminal/log) e trunca.
function sanitizeForLog(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? '?' : ch;
  }
  return out.length > 200 ? out.slice(0, 200) + '...' : out;
}

// Guard minimo: precisa ser objeto com type string. O contrato completo do
// evento (orderId/total/at) fica para o order-service (Bloco 8).
function hasEventShape(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { type?: unknown }).type === 'string'
  );
}

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

    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      console.error(
        '[consumer] payload nao-JSON descartado (' + raw.length + ' bytes, key ' + routingKey + ')'
      );
      channel.nack(msg, false, false);
      return;
    }

    if (!hasEventShape(event)) {
      console.error('[consumer] evento sem shape valido, nack: ' + sanitizeForLog(raw));
      channel.nack(msg, false, false);
      return;
    }

    // ack so APOS validar (sintaxe + shape minimo).
    console.log('[consumer] recebida (' + routingKey + '): ' + sanitizeForLog(JSON.stringify(event)));
    channel.ack(msg);
  });
}

main().catch((err) => {
  console.error('[consumer] erro:', err instanceof Error ? err.message : err);
  process.exit(1);
});
