// Validacao de ambiente em funcoes puras e testaveis (lancam em vez de
// process.exit — testavel sem matar o processo, e reutilizavel).
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const WEAK_SECRETS = [
  'troque_este_segredo',
  'dev_jwt_secret_troque_em_producao',
  'changeme',
  'secret',
];

export function validateRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of REQUIRED_ENV) {
    const value = env[key];
    if (!value || value.trim() === '') {
      throw new Error('Variavel de ambiente obrigatoria ausente: ' + key);
    }
  }
  // Em producao, recusa JWT_SECRET fraca/placeholder (auth entra nos proximos blocos).
  const nodeEnv = env.NODE_ENV || 'development';
  if (nodeEnv === 'production') {
    const secret = env.JWT_SECRET as string;
    if (WEAK_SECRETS.includes(secret) || secret.length < 16) {
      throw new Error('JWT_SECRET fraca ou placeholder — defina um segredo forte');
    }
  }
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORDER_PORT || '3006';
  // Exige inteiro integral (rejeita "3006abc", "1.5"): so digitos.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error('ORDER_PORT invalido: ' + raw);
  }
  const port = parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ORDER_PORT invalido: ' + raw);
  }
  return port;
}
