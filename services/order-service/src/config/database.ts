import dotenv from 'dotenv';
// Carrega as variaveis ANTES de instanciar o PrismaClient.
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { sanitizeConnectionError } from './database-error';

export const prisma = new PrismaClient();

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    console.log('Conectado ao PostgreSQL (order_db)');
  } catch (error) {
    console.error(sanitizeConnectionError(error));
    process.exit(1);
  }
}
