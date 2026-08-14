import { validateRequiredEnv, resolvePort } from '../src/config/env';

describe('validateRequiredEnv', () => {
  it('lanca se DATABASE_URL ausente', () => {
    expect(() => validateRequiredEnv({ JWT_SECRET: 'x' })).toThrow(/DATABASE_URL/);
  });
  it('lanca se JWT_SECRET ausente', () => {
    expect(() => validateRequiredEnv({ DATABASE_URL: 'x' })).toThrow(/JWT_SECRET/);
  });
  it('lanca se JWT_SECRET for so espacos', () => {
    expect(() =>
      validateRequiredEnv({ DATABASE_URL: 'x', JWT_SECRET: '   ' })
    ).toThrow(/JWT_SECRET/);
  });
  it('rejeita JWT_SECRET placeholder em producao', () => {
    expect(() =>
      validateRequiredEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'x',
        JWT_SECRET: 'troque_este_segredo',
      })
    ).toThrow(/JWT_SECRET/);
  });
  it('passa em dev com envs presentes', () => {
    expect(() =>
      validateRequiredEnv({ DATABASE_URL: 'x', JWT_SECRET: 'y' })
    ).not.toThrow();
  });
});

describe('resolvePort', () => {
  it('default 3006 quando ausente', () => {
    expect(resolvePort({})).toBe(3006);
  });
  it('usa ORDER_PORT valido', () => {
    expect(resolvePort({ ORDER_PORT: '3006' })).toBe(3006);
  });
  it('rejeita numerico parcial (3006abc)', () => {
    expect(() => resolvePort({ ORDER_PORT: '3006abc' })).toThrow(/ORDER_PORT/);
  });
  it('rejeita decimal (1.5)', () => {
    expect(() => resolvePort({ ORDER_PORT: '1.5' })).toThrow(/ORDER_PORT/);
  });
  it('rejeita 0 e 65536', () => {
    expect(() => resolvePort({ ORDER_PORT: '0' })).toThrow(/ORDER_PORT/);
    expect(() => resolvePort({ ORDER_PORT: '65536' })).toThrow(/ORDER_PORT/);
  });
  it('rejeita nao-numerico (abc)', () => {
    expect(() => resolvePort({ ORDER_PORT: 'abc' })).toThrow(/ORDER_PORT/);
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
  validateRequiredEnv({ DATABASE_URL: 'postgresql://x', JWT_SECRET: s, NODE_ENV: e });
}
