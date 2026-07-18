// Modulo puro (sem dotenv, sem PrismaClient). Allowlist de nomes de erro
// conhecidos; qualquer outro name vira categoria generica — error.name nunca
// e logado cru. Reusado do inventory-service (revisado no PR #24).
const KNOWN_ERROR_NAMES = new Set([
  'PrismaClientInitializationError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientRustPanicError',
  'PrismaClientValidationError',
]);
const GENERIC_CATEGORY = 'DatabaseConnectionError';

export function sanitizeConnectionError(error: unknown): string {
  const rawName = error instanceof Error ? error.name : '';
  const safeCategory = KNOWN_ERROR_NAMES.has(rawName) ? rawName : GENERIC_CATEGORY;
  return 'Falha ao conectar ao banco de dados: ' + safeCategory;
}
