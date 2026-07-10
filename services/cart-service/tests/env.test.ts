import { loadConfig } from '../src/config/env';

describe('loadConfig', () => {
  it('lanca erro se REDIS_URL faltar fora de dev/test', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/REDIS_URL/);
  });

  it('lanca erro se JWT_SECRET faltar em producao', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', REDIS_URL: 'redis://x:6379' })
    ).toThrow(/JWT_SECRET/);
  });

  it('usa fallbacks locais em test quando envs ausentes', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' });
    expect(cfg.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(cfg.jwtSecret).toBe('dev_jwt_secret_troque_em_producao');
    expect(cfg.cartTtlSeconds).toBe(604800);
  });

  it('aceita envs explicitas em producao', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://:s@host:6379',
      JWT_SECRET: 'segredo',
    });
    expect(cfg.redisUrl).toBe('redis://:s@host:6379');
    expect(cfg.jwtSecret).toBe('segredo');
  });

  it('lanca erro se CART_PORT for invalido', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', CART_PORT: 'abc' })
    ).toThrow(/CART_PORT/);
  });

  it('lanca erro se CART_TTL_SECONDS for invalido', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', CART_TTL_SECONDS: 'abc' })
    ).toThrow(/CART_TTL_SECONDS/);
  });

  it('converte CART_PORT valido para numero', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', CART_PORT: '3005' });
    expect(cfg.port).toBe(3005);
  });
});
