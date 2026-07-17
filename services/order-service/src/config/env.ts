// Validacao de ambiente em funcoes puras e testaveis (lancam em vez de
// process.exit — testavel sem matar o processo, e reutilizavel).
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];

export function validateRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of REQUIRED_ENV) {
    if (!env[key]) {
      throw new Error('Variavel de ambiente obrigatoria ausente: ' + key);
    }
  }
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORDER_PORT || '3006';
  const port = parseInt(raw, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('ORDER_PORT invalido: ' + raw);
  }
  return port;
}
