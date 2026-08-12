// Este modulo NAO le o ambiente. A URL chega ja validada pelo ponto de entrada.
// Motivo (item 4.2 da revisao do PR #47): loadConfig() no topo do modulo seria
// avaliado durante o import, antes do catch centralizado do bootstrap, e rodaria
// duas vezes.
import { PrismaClient } from '@prisma/client';
import { sanitizeConnectionError } from './database-error';

let clienteAtivo: PrismaClient | null = null;

/** Constroi um cliente a partir de uma URL ja validada. Nao conecta. */
function criarPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

/**
 * Conecta e registra o cliente do processo. Chamado uma unica vez pelo
 * ponto de entrada, antes de o servidor abrir a porta.
 */
export async function connectDatabase(databaseUrl: string): Promise<PrismaClient> {
  const cliente = criarPrismaClient(databaseUrl);

  try {
    await cliente.$connect();
    // Mensagem neutra: o nome do banco varia por ambiente e a URL tem segredo.
    console.log('[payment-service] Conectado ao PostgreSQL');
    clienteAtivo = cliente;
    return cliente;
  } catch (error) {
    // Libera o socket antes de propagar: falha de conexao nao deve vazar recurso.
    await cliente.$disconnect().catch(() => undefined);
    throw new Error(sanitizeConnectionError(error));
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (clienteAtivo) {
    await clienteAtivo.$disconnect();
    clienteAtivo = null;
  }
}
