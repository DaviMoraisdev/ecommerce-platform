import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { connectDatabase } from './config/database';
import { validateRequiredEnv, resolvePort } from './config/env';
import { initEventPublisher, closeEventPublisher } from './events/publisher';

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
  // Publisher de eventos: best-effort. Se o broker estiver fora, o servico
  // AINDA sobe e atende pedidos — eventos sao a parte nao-critica (at-most-once).
  try {
    await initEventPublisher();
  } catch (err) {
    console.warn(
      '[events] publisher indisponivel no boot, seguindo sem eventos: ' +
        (err instanceof Error ? err.message : String(err))
    );
  }

  const server = app.listen(port, () => {
    console.log('Order service rodando na porta ' + port);
  });

  // Encerramento gracioso: para de aceitar conexoes, fecha o publisher e sai.
  async function shutdown(signal: string): Promise<void> {
    console.log('[order] ' + signal + ' recebido; encerrando graciosamente...');
    server.close();
    await closeEventPublisher();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer();
