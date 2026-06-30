import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { connectDatabase } from './config/database';

// Validacao de variaveis obrigatorias no boot — falha clara em vez de erro
// misterioso depois. process.exit fica AQUI, no ponto de entrada, nunca no app.
const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Variavel de ambiente obrigatoria ausente: ${key}`);
    process.exit(1);
  }
}

const PORT = process.env.PRODUCT_PORT || 3003;

async function startServer() {
  await connectDatabase();
  app.listen(PORT, () => {
    console.log(`Product service rodando na porta ${PORT}`);
  });
}

startServer();
