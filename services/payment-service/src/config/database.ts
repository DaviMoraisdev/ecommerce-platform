// Sem dotenv aqui: o carregamento acontece uma unica vez em ./env, que este
// modulo importa. Fonte unica de configuracao — a duplicacao anterior permitia
// que o Prisma conectasse a uma URL diferente da que loadConfig() validou.
import { PrismaClient } from '@prisma/client';
import { loadConfig } from './env';
import { sanitizeConnectionError } from './database-error';

const config = loadConfig();

// datasourceUrl vem da config JA VALIDADA, e nao do process.env global.
// (O schema.prisma continua com env("DATABASE_URL") porque a CLI do Prisma —
// migrate, generate, studio — roda fora do processo da aplicacao.)
export const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    // Mensagem neutra: o nome do banco varia por ambiente e a URL tem segredo.
    console.log('[payment-service] Conectado ao PostgreSQL');
  } catch (error) {
    // Lanca erro ja sanitizado; process.exit fica no ponto de entrada.
    throw new Error(sanitizeConnectionError(error));
  }
}
