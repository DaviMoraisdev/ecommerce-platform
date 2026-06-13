import dotenv from 'dotenv';
// Carrega as variaveis ANTES de instanciar o PrismaClient
dotenv.config();

import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    console.log('Conectado ao PostgreSQL (inventory_db)');
  } catch (error) {
    // Log sanitizado: nao expoe detalhes internos do banco
    const message = error instanceof Error ? error.name : 'Erro desconhecido';
    console.error('Falha ao conectar ao banco de dados:', message);
    process.exit(1);
  }
}
