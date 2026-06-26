import dotenv from 'dotenv';
// Carrega as variaveis ANTES de instanciar o PrismaClient
dotenv.config();
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// Funcao pura e testavel: recebe um erro de conexao e devolve uma
// mensagem segura para log. Expoe apenas o NOME da classe do erro,
// nunca a mensagem crua (que pode conter a DATABASE_URL e a senha).
export function sanitizeConnectionError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  return `Falha ao conectar ao banco de dados: ${name}`;
}

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    console.log('Conectado ao PostgreSQL (inventory_db)');
  } catch (error) {
    console.error(sanitizeConnectionError(error));
    process.exit(1);
  }
}