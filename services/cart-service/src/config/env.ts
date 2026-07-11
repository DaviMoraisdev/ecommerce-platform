export interface AppConfig {
  port: number;
  redisUrl: string;
  jwtSecret: string;
  cartTtlSeconds: number;
  nodeEnv: string;
}

const WEAK_JWT_SECRETS = [
  'troque_este_segredo',
  'dev_jwt_secret_troque_em_producao',
  'changeme',
  'secret',
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';

  const redisUrl = env.REDIS_URL;
  if (!redisUrl && !isDevOrTest) {
    throw new Error('REDIS_URL e obrigatoria fora de development/test');
  }

  // JWT_SECRET e SEMPRE obrigatoria: sem fallback executavel conhecido.
  // Assim, um deploy sem NODE_ENV=production nao pode usar um segredo publico.
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.trim() === '') {
    throw new Error('JWT_SECRET e obrigatoria');
  }
  // Em producao, recusa placeholders conhecidos e segredos curtos.
  if (nodeEnv === 'production') {
    if (WEAK_JWT_SECRETS.includes(jwtSecret) || jwtSecret.length < 16) {
      throw new Error('JWT_SECRET fraca ou placeholder — defina um segredo forte');
    }
  }

  const rawPort = env.CART_PORT;
  const port = rawPort ? Number(rawPort) : 3005;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CART_PORT invalido: ' + String(rawPort));
  }

  const rawTtl = env.CART_TTL_SECONDS;
  const cartTtlSeconds = rawTtl ? Number(rawTtl) : 604800;
  if (!Number.isInteger(cartTtlSeconds) || cartTtlSeconds < 1) {
    throw new Error('CART_TTL_SECONDS invalido: ' + String(rawTtl));
  }

  return {
    port,
    redisUrl: redisUrl ?? 'redis://127.0.0.1:6379',
    jwtSecret,
    cartTtlSeconds,
    nodeEnv,
  };
}
