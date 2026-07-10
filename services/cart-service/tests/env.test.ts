import { loadConfig } from '../src/config/env';

describe('loadConfig', () => {
  const base = { NODE_ENV: 'test', JWT_SECRET: 'x' };

  it('lanca erro se REDIS_URL faltar fora de dev/test', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'um_segredo_forte_123' })
    ).toThrow(/REDIS_URL/);
  });

  it('lanca erro se JWT_SECRET faltar (qualquer ambiente)', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/JWT_SECRET/);
  });

  it('rejeita JWT_SECRET placeholder/fraca em producao', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://x:6379',
        JWT_SECRET: 'troque_este_segredo',
      })
    ).toThrow(/JWT_SECRET/);
  });

  it('usa fallback local de REDIS em test', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.redisUrl).toBe('redis://127.0.0.1:6379');
  });

  it('aceita configuracao valida em producao', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://:s@host:6379',
      JWT_SECRET: 'um_segredo_bem_forte_2026',
    });
    expect(cfg.jwtSecret).toBe('um_segredo_bem_forte_2026');
  });

  it('lanca erro se CART_PORT for invalido', () => {
    expect(() => loadConfig({ ...base, CART_PORT: 'abc' })).toThrow(/CART_PORT/);
  });

  it('lanca erro se CART_TTL_SECONDS for invalido', () => {
    expect(() =>
      loadConfig({ ...base, CART_TTL_SECONDS: 'abc' })
    ).toThrow(/CART_TTL_SECONDS/);
  });

  it('converte CART_PORT valido para numero', () => {
    const cfg = loadConfig({ ...base, CART_PORT: '3005' });
    expect(cfg.port).toBe(3005);
  });
});
