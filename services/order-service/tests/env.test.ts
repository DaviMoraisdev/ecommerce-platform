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
