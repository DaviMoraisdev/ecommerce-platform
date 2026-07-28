import dotenv from 'dotenv';
dotenv.config();
import { connect } from './config/connection';
import { EXCHANGE, EXCHANGE_TYPE, QUEUE, BINDING_KEY } from './config/topology';
import { parseEvent, handleEvent, sanitizeForLog } from './consumer';

async function start() {
  const connection = await connect();
  const channel = await connection.createChannel();

  // O consumidor e dono da fila: declara exchange, fila e binding.
  await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, BINDING_KEY);
  await channel.prefetch(1);

  console.log(
    '[notification] consumindo ' + QUEUE + ' (binding ' + BINDING_KEY + ' no exchange ' + EXCHANGE + ')'
  );

  await channel.consume(QUEUE, (msg) => {
    if (!msg) return;
    const routingKey = msg.fields.routingKey;
    const raw = msg.content.toString();

    const event = parseEvent(raw);
    if (!event) {
      // Payload invalido = mensagem envenenada. Descarta sem requeue (nao loopa).
      console.error(
        '[notification] payload invalido descartado (key ' + routingKey + '): ' + sanitizeForLog(raw)
      );
      channel.nack(msg, false, false);
      return;
    }

    try {
      handleEvent(event);
      channel.ack(msg); // ack SO apos processar com sucesso
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[notification] falha ao processar ' + routingKey + ': ' + reason);
      channel.nack(msg, false, false);
    }
  });

  // Encerramento gracioso por sinal: fecha canal e conexao antes de sair.
  async function shutdown(signal: string): Promise<void> {
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
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Consumer sem conexao nao tem funcao: encerra para o supervisor reiniciar.
  connection.on('close', () => {
    console.error('[notification] conexao fechada; encerrando (exit 1) para reiniciar');
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('[notification] erro fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
