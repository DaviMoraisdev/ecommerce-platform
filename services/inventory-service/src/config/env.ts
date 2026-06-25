// Validacao de ambiente em funcoes puras e testaveis.
// Lancam erro em vez de chamar process.exit — isso permite testar o
// comportamento sem matar o processo de teste, e torna o codigo reutilizavel.

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];

// Verifica que todas as variaveis obrigatorias estao presentes.
// Lanca Error listando a primeira ausente.
export function validateRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of REQUIRED_ENV) {
    if (!env[key]) {
      throw new Error(`Variavel de ambiente obrigatoria ausente: ${key}`);
    }
  }
}

// Resolve e valida a porta. Retorna o numero valido ou lanca Error.
// Default 3004 se INVENTORY_PORT nao estiver definido.
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INVENTORY_PORT || '3004';
  const port = parseInt(raw, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`INVENTORY_PORT invalido: ${raw}`);
  }
  return port;
}
