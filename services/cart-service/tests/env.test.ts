import { loadConfig } from '../src/config/env';

describe('loadConfig', () => {
  it('lanca erro se REDIS_URL faltar fora de dev/test', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/REDIS_URL/);
  });

  it('usa fallback local em test quando REDIS_URL ausente', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' });
    expect(cfg.redisUrl).toBe('redis://127.0.0.1:6379');
  });

  it('aceita REDIS_URL explicita em producao', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://:s@host:6379',
    });
    expect(cfg.redisUrl).toBe('redis://:s@host:6379');
  });

  it('lanca erro se CART_PORT for invalido', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', CART_PORT: 'abc' })
    ).toThrow(/CART_PORT/);
  });

  it('converte CART_PORT valido para numero', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', CART_PORT: '3005' });
    expect(cfg.port).toBe(3005);
  });
});
