import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    console.log('Conectado ao PostgreSQL (inventory_db)');
  } catch (error) {
    console.error('Erro ao conectar ao banco:', error);
    process.exit(1);
  }
}
