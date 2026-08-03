export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol + '//' + u.host; // sem user:pass, query nem fragment
  } catch {
    return '<url invalida>';
  }
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || v.trim() === '') throw new Error('e2e: variavel obrigatoria ausente: ' + name);
  return v;
}

// Trava de ambiente: por padrao so localhost (a suite cria dados + usa JWT ADMIN).
export function assertLocalTarget(url: string, allowDestructive: boolean): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('e2e: URL invalida: ' + redactUrl(url));
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!local && !allowDestructive) {
    throw new Error(
      'e2e BLOQUEADO: alvo nao-local (' + host + '). Rode apenas contra localhost, ou defina ' +
        'E2E_ALLOW_DESTRUCTIVE=true conscientemente.'
    );
  }
  return url;
}

export interface E2eConfig {
  secret: string;
  urls: { product: string; inventory: string; cart: string; order: string; auth: string; redis: string };
  httpTimeoutMs: number;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): E2eConfig {
  const allow = env.E2E_ALLOW_DESTRUCTIVE === 'true';
  const secret = requireEnv(env, 'JWT_SECRET');
  if (secret === 'troque_este_segredo') {
    throw new Error('e2e: JWT_SECRET e o placeholder; use o segredo real dos servicos no .env');
  }
  const t = (name: string): string => assertLocalTarget(requireEnv(env, name), allow);
  const timeout = Number(env.E2E_HTTP_TIMEOUT_MS);
  return {
    secret,
    urls: {
      product: t('PRODUCT_URL'),
      inventory: t('INVENTORY_URL'),
      cart: t('CART_URL'),
      order: t('ORDER_URL'),
      auth: t('AUTH_URL'),
      redis: t('REDIS_URL'),
    },
    httpTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 8000,
  };
}
