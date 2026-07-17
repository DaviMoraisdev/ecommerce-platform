import { validateRequiredEnv, resolvePort } from '../src/config/env';

describe('validateRequiredEnv', () => {
  it('lanca se DATABASE_URL ausente', () => {
    expect(() => validateRequiredEnv({ JWT_SECRET: 'x' })).toThrow(/DATABASE_URL/);
  });
  it('lanca se JWT_SECRET ausente', () => {
    expect(() => validateRequiredEnv({ DATABASE_URL: 'x' })).toThrow(/JWT_SECRET/);
  });
  it('passa quando ambas presentes', () => {
    expect(() =>
      validateRequiredEnv({ DATABASE_URL: 'x', JWT_SECRET: 'y' })
    ).not.toThrow();
  });
});

describe('resolvePort', () => {
  it('default 3006 quando ORDER_PORT ausente', () => {
    expect(resolvePort({})).toBe(3006);
  });
  it('usa ORDER_PORT valido', () => {
    expect(resolvePort({ ORDER_PORT: '3006' })).toBe(3006);
  });
  it('lanca em ORDER_PORT invalido', () => {
    expect(() => resolvePort({ ORDER_PORT: 'abc' })).toThrow(/ORDER_PORT/);
  });
});
