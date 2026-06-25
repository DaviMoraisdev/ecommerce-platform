import dotenv from 'dotenv';
dotenv.config();
import app from './app';
import { connectDatabase } from './config/database';
import { validateRequiredEnv, resolvePort } from './config/env';

async function startServer() {
  // Valida o ambiente. Se invalido, as funcoes lancam — capturamos aqui,
  // no ponto de entrada, e encerramos o processo com codigo de erro.
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
    console.log(`Inventory service rodando na porta ${port}`);
  });
}

startServer();
