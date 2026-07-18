import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { sanitizeConnectionError } from './database-error';

export const prisma = new PrismaClient();

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    console.log('Conectado ao PostgreSQL (order_db)');
  } catch (error) {
    // Lanca erro ja sanitizado; process.exit fica no ponto de entrada.
    throw new Error(sanitizeConnectionError(error));
  }
}
