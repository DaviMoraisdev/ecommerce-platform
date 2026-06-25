import { prisma } from '../src/config/database';

// Roda UMA vez, apos todas as suites. Centraliza o disconnect para evitar
// que suites diferentes tentem desconectar a mesma instancia singleton.
export default async function globalTeardown() {
  await prisma.$disconnect();
}
