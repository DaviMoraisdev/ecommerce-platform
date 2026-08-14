export interface AppConfig {
  port: number;
  redisUrl: string;
  jwtSecret: string;
  cartTtlSeconds: number;
  nodeEnv: string;
}

// Valores publicados no repositorio ou genericos. Recusados em QUALQUER
// ambiente: segredo que esta no repositorio e segredo publico.
const JWT_PLACEHOLDERS = [
  'troque_este_segredo',
  'dev_jwt_secret_troque_em_producao',
  'sua_chave_secreta_aqui',
  'um_segredo_de_teste',
  'coloque-um-segredo-de-teste-aqui',
  'changeme',
  'change_me',
  'secret',
  'segredo',
  'test',
  'teste',
];

/** 32 caracteres. Recomendado: `openssl rand -hex 32` (64 caracteres). */
const JWT_TAMANHO_MINIMO = 32;

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
  // Placeholder: recusado em QUALQUER ambiente. O cenario de risco e alguem
  // copiar o .env.example e subir em desenvolvimento.
  if (JWT_PLACEHOLDERS.includes(jwtSecret.trim().toLowerCase())) {
    throw new Error(
      'JWT_SECRET e um placeholder conhecido, publicado no repositorio. ' +
        'Gere um segredo real: openssl rand -hex 32',
    );
  }

  // Tamanho: so em producao. Segredo curto ESCOLHIDO pelo operador nao e
  // publico, e exigir 32 em dev cria atrito sem ganho de seguranca.
  if (nodeEnv === 'production' && jwtSecret.length < JWT_TAMANHO_MINIMO) {
    throw new Error(
      `JWT_SECRET tem menos de ${JWT_TAMANHO_MINIMO} caracteres — insuficiente em producao`,
    );
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
