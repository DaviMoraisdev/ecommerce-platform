import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import app from './app';
import { connectDatabase } from './config/database';
import { validateRequiredEnv, resolvePort } from './config/env';
import { closeEventPublisher } from './events/publisher';
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

  // O relay e o UNICO responsavel por conectar o publisher (single-flight) e
  // publicar os eventos gravados na transacao (at-least-once). Nao bloqueia o boot.
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
