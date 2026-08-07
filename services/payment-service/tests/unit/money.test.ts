import {
  toCents,
  fromCents,
  assertValidCents,
  equals,
  MoneyError,
  MAX_AMOUNT_CENTS,
} from '../../src/domain/money';

describe('toCents', () => {
  it.each([
    ['0', 0],
    ['12', 1200],
    ['12.9', 1290],
    ['12.90', 1290],
    ['12.29', 1229],
    ['0.01', 1],
    ['129.99', 12999],
  ])('converte "%s" para %i centavos', (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it('aceita number quando a representacao decimal e exata', () => {
    expect(toCents(12.29)).toBe(1229);
  });

  it('rejeita float corrompido em vez de arredondar', () => {
    // String(0.1 + 0.2) === "0.30000000000000004"
    expect(() => toCents(0.1 + 0.2)).toThrow(MoneyError);
  });

  it('rejeita mais de duas casas decimais em vez de arredondar', () => {
    expect(() => toCents('12.295')).toThrow(MoneyError);
    expect(() => toCents(12.295)).toThrow(MoneyError);
  });

  it.each(['-1', 'abc', '', '1,50', '1.2.3', 'NaN'])(
    'rejeita entrada invalida "%s"',
    (input) => {
      expect(() => toCents(input)).toThrow(MoneyError);
    },
  );

  it.each([NaN, Infinity, -Infinity])('rejeita number nao finito %p', (input) => {
    expect(() => toCents(input)).toThrow(MoneyError);
  });

  it('rejeita notacao cientifica', () => {
    expect(() => toCents(1e21)).toThrow(MoneyError);
  });

  it('rejeita valor acima do teto', () => {
    expect(() => toCents('10000000.01')).toThrow(MoneyError);
  });
});

describe('fromCents', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [1290, '12.90'],
    [12999, '129.99'],
  ])('formata %i como "%s"', (input, expected) => {
    expect(fromCents(input)).toBe(expected);
  });

  it.each(['0.01', '12.90', '129.99', '0'])(
    'ida e volta preserva o valor de "%s"',
    (input) => {
      expect(toCents(fromCents(toCents(input)))).toBe(toCents(input));
    },
  );
});

describe('assertValidCents', () => {
  it('aceita inteiro nao-negativo dentro do teto', () => {
    expect(() => assertValidCents(0)).not.toThrow();
    expect(() => assertValidCents(MAX_AMOUNT_CENTS)).not.toThrow();
  });

  it.each([1.5, -1, MAX_AMOUNT_CENTS + 1])('rejeita %p', (input) => {
    expect(() => assertValidCents(input)).toThrow(MoneyError);
  });
});

describe('equals', () => {
  it('compara valores da mesma moeda', () => {
    expect(equals({ amountCents: 100, currency: 'BRL' }, { amountCents: 100, currency: 'BRL' })).toBe(true);
    expect(equals({ amountCents: 100, currency: 'BRL' }, { amountCents: 101, currency: 'BRL' })).toBe(false);
  });

  it('lanca ao comparar moedas diferentes em vez de retornar false', () => {
    const brl = { amountCents: 100, currency: 'BRL' as const };
    const outra = { amountCents: 100, currency: 'USD' as unknown as 'BRL' };
    expect(() => equals(brl, outra)).toThrow(MoneyError);
  });
});
