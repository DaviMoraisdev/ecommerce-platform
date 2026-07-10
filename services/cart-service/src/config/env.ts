export interface AppConfig {
  port: number;
  redisUrl: string;
  jwtSecret: string;
  cartTtlSeconds: number;
  nodeEnv: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';

  const redisUrl = env.REDIS_URL;
  if (!redisUrl && !isDevOrTest) {
    throw new Error('REDIS_URL e obrigatoria fora de development/test');
  }

  // JWT_SECRET valida tokens emitidos pelo auth-service. DEVE ser o mesmo
  // segredo do auth-service, senao a verificacao falha. Obrigatorio em prod.
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret && !isDevOrTest) {
    throw new Error('JWT_SECRET e obrigatoria fora de development/test');
  }

  const rawPort = env.CART_PORT;
  const port = rawPort ? Number(rawPort) : 3005;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CART_PORT invalido: ' + String(rawPort));
  }

  // TTL do carrinho: expiracao deslizante, renovada a cada escrita.
  // Default 7 dias. Carrinho abandonado morre; carrinho ativo persiste.
  const rawTtl = env.CART_TTL_SECONDS;
  const cartTtlSeconds = rawTtl ? Number(rawTtl) : 604800;
  if (!Number.isInteger(cartTtlSeconds) || cartTtlSeconds < 1) {
    throw new Error('CART_TTL_SECONDS invalido: ' + String(rawTtl));
  }

  return {
    port,
    redisUrl: redisUrl ?? 'redis://127.0.0.1:6379',
    jwtSecret: jwtSecret ?? 'dev_jwt_secret_troque_em_producao',
    cartTtlSeconds,
    nodeEnv,
  };
}
