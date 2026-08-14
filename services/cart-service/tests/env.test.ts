import { loadConfig } from '../src/config/env';

describe('loadConfig', () => {
  const base = { NODE_ENV: 'test', JWT_SECRET: 'x' };

  it('lanca erro se REDIS_URL faltar fora de dev/test', () => {
    // O segredo aqui e curto DE PROPOSITO: em producao ele tambem seria
    // recusado. Como a asercao exige /REDIS_URL/, este teste prova que o Redis
    // e verificado ANTES do JWT — com um segredo forte, a ordem nao seria testada.
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
      JWT_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
    });
    expect(cfg.jwtSecret).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718');
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

describe('JWT_SECRET — placeholder e forca', () => {
  const FORTE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

  // O cenario do achado de seguranca: alguem copia o .env.example e sobe em
  // DESENVOLVIMENTO. Recusar so em producao nao pegaria este caso.
  it.each([
    'troque_este_segredo',
    'dev_jwt_secret_troque_em_producao',
    'sua_chave_secreta_aqui',
    'changeme',
    'secret',
    'segredo',
  ])('recusa o placeholder %p em desenvolvimento', (placeholder) => {
    expect(() => chamar(placeholder, 'development')).toThrow(/placeholder/i);
  });

  it('recusa placeholder ignorando caixa e espacos', () => {
    expect(() => chamar('  TROQUE_ESTE_SEGREDO  ', 'development')).toThrow(/placeholder/i);
  });

  it('aceita segredo forte em qualquer ambiente', () => {
    expect(() => chamar(FORTE, 'development')).not.toThrow();
    expect(() => chamar(FORTE, 'production')).not.toThrow();
  });

  it('em DESENVOLVIMENTO aceita segredo curto que nao e placeholder', () => {
    expect(() => chamar('curto_mas_proprio', 'development')).not.toThrow();
  });

  it('em PRODUCAO recusa segredo com menos de 32 caracteres', () => {
    expect(() => chamar('curto_mas_proprio', 'production')).toThrow(/32 caracteres/);
  });

  it('em PRODUCAO aceita exatamente 32 caracteres', () => {
    expect(() => chamar('a'.repeat(32), 'production')).not.toThrow();
  });
});

function chamar(s: string, e: string): void {
  // REDIS_URL entra na linha de base: loadConfig a exige fora de development e
  // test, e sem ela o caso de producao falharia por motivo alheio ao segredo.
  loadConfig({ JWT_SECRET: s, NODE_ENV: e, REDIS_URL: 'redis://127.0.0.1:6379' });
}
