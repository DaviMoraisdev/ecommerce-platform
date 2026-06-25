import { prisma } from '../src/config/database';

// Roda UMA vez, apos todas as suites. Desconecta o Prisma de forma tolerante:
// algumas suites (ex: env.test, funcoes puras) nao usam banco, entao o
// disconnect aqui apenas garante que qualquer conexao aberta seja fechada,
// sem falhar se nao houver nada a desconectar.
export default async function globalTeardown() {
  try {
    await prisma.$disconnect();
  } catch {
    // Ignora: se nao havia conexao ativa, nao ha o que fechar
  }
}
