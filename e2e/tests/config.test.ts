import { resolveConfig, assertLocalTarget, redactUrl } from '../src/config';

const baseEnv = {
  JWT_SECRET: 'segredo-real-de-teste',
  PRODUCT_URL: 'http://localhost:3003',
  INVENTORY_URL: 'http://127.0.0.1:3004',
  CART_URL: 'http://localhost:3005',
  ORDER_URL: 'http://localhost:3006',
  AUTH_URL: 'http://localhost:3001',
  REDIS_URL: 'redis://:senha@127.0.0.1:6379',
} as NodeJS.ProcessEnv;

describe('config e2e (trava e validacao)', () => {
  it('aceita alvos locais e o segredo real', () => {
    const cfg = resolveConfig(baseEnv);
    expect(cfg.secret).toBe('segredo-real-de-teste');
    expect(cfg.urls.order).toBe('http://localhost:3006');
    expect(cfg.httpTimeoutMs).toBe(8000);
  });

  it('rejeita o placeholder do JWT_SECRET', () => {
    expect(() => resolveConfig({ ...baseEnv, JWT_SECRET: 'troque_este_segredo' })).toThrow(/placeholder/);
  });

  it('rejeita variavel obrigatoria ausente', () => {
    const semOrder: NodeJS.ProcessEnv = { ...baseEnv };
    delete semOrder.ORDER_URL;
    expect(() => resolveConfig(semOrder)).toThrow(/ORDER_URL/);
  });

  it('assertLocalTarget: locais passam', () => {
    expect(assertLocalTarget('http://localhost:1', false)).toBeDefined();
    expect(assertLocalTarget('http://127.0.0.1:1', false)).toBeDefined();
    expect(assertLocalTarget('http://[::1]:1', false)).toBeDefined();
  });

  it('assertLocalTarget: host remoto bloqueado por padrao', () => {
    expect(() => assertLocalTarget('https://staging.exemplo.com', false)).toThrow(/BLOQUEADO/);
  });

  it('assertLocalTarget: host remoto liberado com allowDestructive', () => {
    expect(assertLocalTarget('https://staging.exemplo.com', true)).toBe('https://staging.exemplo.com');
  });

  it('assertLocalTarget: URL invalida rejeita', () => {
    expect(() => assertLocalTarget('nao-e-url', false)).toThrow(/URL invalida/);
  });

  it('redactUrl remove usuario e senha', () => {
    const out = redactUrl('redis://user:secret@127.0.0.1:6379/0?x=1');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('user');
    expect(out).toContain('127.0.0.1');
  });

  it('timeout invalido cai no default; valido e respeitado', () => {
    expect(resolveConfig({ ...baseEnv, E2E_HTTP_TIMEOUT_MS: 'abc' }).httpTimeoutMs).toBe(8000);
    expect(resolveConfig({ ...baseEnv, E2E_HTTP_TIMEOUT_MS: '2500' }).httpTimeoutMs).toBe(2500);
  });
});
