import dotenv from 'dotenv';
dotenv.config();

import app from './app';

// Validacao de env obrigatoria no boot fica AQUI, no ponto de entrada, nunca no app.
// Vazio por enquanto: CART_PORT e REDIS_URL tem defaults sensatos para dev.
// JWT_SECRET entra nesta lista no Bloco 2, quando o carrinho virar por-usuario.
const REQUIRED_ENV: string[] = [];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Variavel de ambiente obrigatoria ausente: ${key}`);
    process.exit(1);
  }
}

const PORT = process.env.CART_PORT || 3005;

app.listen(PORT, () => {
  console.log(`Cart service rodando na porta ${PORT}`);
});
