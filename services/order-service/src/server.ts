import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { connectDatabase } from './config/database';
import { validateRequiredEnv, resolvePort } from './config/env';

async function startServer() {
  // Valida env no ponto de entrada; process.exit fica so aqui.
  let port: number;
  try {
    validateRequiredEnv();
    port = resolvePort();
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Erro de configuracao');
    process.exit(1);
  }
  await connectDatabase();
  app.listen(port, () => {
    console.log('Order service rodando na porta ' + port);
  });
}

startServer();
