import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { connectDatabase } from './config/database';
import { validateRequiredEnv } from './config/env';

// Validacao de ambiente no boot — falha clara em vez de erro misterioso depois.
// A regra vive em config/env.ts (pura e testavel); process.exit fica AQUI, no
// ponto de entrada, nunca no app.
try {
  validateRequiredEnv();
} catch (erro) {
  console.error((erro as Error).message);
  process.exit(1);
}

const PORT = process.env.PRODUCT_PORT || 3003;

async function startServer() {
  await connectDatabase();
  app.listen(PORT, () => {
    console.log(`Product service rodando na porta ${PORT}`);
  });
}

startServer();
