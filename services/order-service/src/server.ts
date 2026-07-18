import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { connectDatabase } from './config/database';
import { validateRequiredEnv, resolvePort } from './config/env';

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
  app.listen(port, () => {
    console.log('Order service rodando na porta ' + port);
  });
}

startServer();
