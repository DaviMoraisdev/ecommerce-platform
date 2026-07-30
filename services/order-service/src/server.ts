import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { connectDatabase } from './config/database';
import { validateRequiredEnv, resolvePort } from './config/env';
import { initEventPublisher, closeEventPublisher } from './events/publisher';
import { startOutboxRelay, stopOutboxRelay } from './events/outbox.relay';

async function startServer() {
  // process.exit fica SO aqui, no ponto de entrada.
  let port: number;
  try {
    validateRequiredEnv();
    port = resolvePort();
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Erro de configuracao');
    process.exit(1);
  }
  try {
    await connectDatabase();
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Erro de conexao');
    process.exit(1);
  }
  const server = app.listen(port, () => {
    console.log('Order service rodando na porta ' + port);
  });

  // Publisher em BACKGROUND: nao bloqueia o boot. Se o broker estiver fora ou
  // lento, o servico ja esta atendendo; eventos sao best-effort (at-most-once).
  void initEventPublisher().catch((err) => {
    console.warn(
      '[events] publisher indisponivel, seguindo sem eventos: ' +
        (err instanceof Error ? err.message : String(err))
    );
  });

  // Relay da outbox: publica os eventos gravados na transacao (at-least-once).
  startOutboxRelay();

  // Encerramento gracioso: drena o HTTP (com teto), fecha o publisher e sai.
  async function shutdown(signal: string): Promise<void> {
    console.log('[order] ' + signal + ' recebido; encerrando graciosamente...');
    await stopOutboxRelay();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await closeEventPublisher();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer();
