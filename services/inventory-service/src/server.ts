import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { connectDatabase } from './config/database';

const REQUIRED_ENV = ['DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Variavel de ambiente obrigatoria ausente: ${key}`);
    process.exit(1);
  }
}

// Valida a porta: deve ser inteiro entre 1 e 65535
function resolvePort(): number {
  const raw = process.env.INVENTORY_PORT || '3004';
  const port = parseInt(raw, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`INVENTORY_PORT invalido: ${raw}`);
    process.exit(1);
  }
  return port;
}

async function startServer() {
  const PORT = resolvePort();
  await connectDatabase();
  app.listen(PORT, () => {
    console.log(`Inventory service rodando na porta ${PORT}`);
  });
}

startServer();
