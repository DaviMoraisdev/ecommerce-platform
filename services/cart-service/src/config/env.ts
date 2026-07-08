export interface AppConfig {
  port: number;
  redisUrl: string;
  nodeEnv: string;
}

// Le e valida a configuracao a partir de um objeto de env (default: process.env).
// Recebe env por parametro justamente para ser testavel sem mexer no process real.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';

  // REDIS_URL e obrigatoria fora de dev/test: evita subir em producao
  // apontando para um Redis local sem auth (health check falso-positivo).
  const redisUrl = env.REDIS_URL;
  if (!redisUrl && !isDevOrTest) {
    throw new Error('REDIS_URL e obrigatoria fora de development/test');
  }

  // CART_PORT: coage para numero e valida a faixa valida de portas TCP.
  const rawPort = env.CART_PORT;
  const port = rawPort ? Number(rawPort) : 3005;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CART_PORT invalido: ' + String(rawPort));
  }

  return {
    port,
    redisUrl: redisUrl ?? 'redis://127.0.0.1:6379',
    nodeEnv,
  };
}
