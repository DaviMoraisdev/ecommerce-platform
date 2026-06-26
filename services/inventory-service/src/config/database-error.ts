// Modulo puro, SEM efeitos colaterais (sem dotenv, sem PrismaClient).
// Isola a logica de sanitizacao para ser testavel sem acoplar ao Prisma.

// Allowlist de nomes de erro conhecidos e seguros para exibir.
// Qualquer name fora deste conjunto e tratado como categoria generica —
// assim, mesmo que error.name contenha dado sensivel, ele NUNCA e logado.
const KNOWN_ERROR_NAMES = new Set([
  'PrismaClientInitializationError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientRustPanicError',
  'PrismaClientValidationError',
]);

const GENERIC_CATEGORY = 'DatabaseConnectionError';

// Recebe um erro de conexao e devolve uma mensagem segura para log.
// Nao confia no conteudo do erro: a saida so pode ser um valor de um
// conjunto controlado aqui, jamais um valor vindo do proprio erro.
export function sanitizeConnectionError(error: unknown): string {
  const rawName = error instanceof Error ? error.name : '';
  const safeCategory = KNOWN_ERROR_NAMES.has(rawName) ? rawName : GENERIC_CATEGORY;
  return `Falha ao conectar ao banco de dados: ${safeCategory}`;
}
