import { parsePositiveInt } from '../src/controllers/product.controller';
import { pickAllowedFields } from '../src/services/product.service';

// Assercao forte para o caso de erro: nao basta ser "object" (null tambem e
// object em JS). Confirma que tem .error string nao-vazia — a forma real do erro.
function expectValidationError(result: ReturnType<typeof parsePositiveInt>) {
  expect(result).not.toBeNull();
  expect(typeof result).toBe('object');
  const err = result as { error: string };
  expect(typeof err.error).toBe('string');
  expect(err.error.length).toBeGreaterThan(0);
}

describe('parsePositiveInt', () => {
  it('aceita um inteiro positivo valido', () => {
    expect(parsePositiveInt('5', 'page', 10000)).toBe(5);
  });

  it('aceita o limite inferior (1)', () => {
    expect(parsePositiveInt('1', 'page', 10000)).toBe(1);
  });

  it('aceita exatamente o maximo permitido', () => {
    expect(parsePositiveInt('50', 'limit', 50)).toBe(50);
  });

  it('rejeita decimal', () => {
    const result = parsePositiveInt('2.5', 'limit', 50);
    expectValidationError(result);
    expect((result as { error: string }).error).toContain('limit');
  });

  it('rejeita letras', () => {
    expectValidationError(parsePositiveInt('abc', 'page', 10000));
  });

  it('rejeita negativo', () => {
    expectValidationError(parsePositiveInt('-3', 'page', 10000));
  });

  it('rejeita zero (menor que 1)', () => {
    const result = parsePositiveInt('0', 'page', 10000);
    expectValidationError(result);
    expect((result as { error: string }).error).toContain('1');
  });

  it('rejeita valor acima do maximo', () => {
    const result = parsePositiveInt('51', 'limit', 50);
    expectValidationError(result);
    expect((result as { error: string }).error).toContain('maximo');
  });

  it('rejeita string vazia', () => {
    expectValidationError(parsePositiveInt('', 'page', 10000));
  });
});

describe('pickAllowedFields', () => {
  it('mantem os campos permitidos', () => {
    const input = {
      name: 'Produto',
      description: 'desc',
      price: 10,
      category: 'cat',
      imageUrl: 'http://x/y.png',
    };
    const result = pickAllowedFields(input);
    expect(result).toEqual(input);
  });

  it('descarta o campo active', () => {
    const result = pickAllowedFields({ name: 'P', active: false });
    expect(result).not.toHaveProperty('active');
    expect(result).toHaveProperty('name', 'P');
  });

  it('descarta campos arbitrarios fora da allowlist', () => {
    const result = pickAllowedFields({ name: 'P', _id: 'hack', role: 'ADMIN' });
    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('role');
    expect(result).toHaveProperty('name', 'P');
  });

  it('ignora campos undefined', () => {
    const result = pickAllowedFields({ name: 'P', price: undefined });
    expect(result).toHaveProperty('name', 'P');
    expect(result).not.toHaveProperty('price');
  });

  it('retorna objeto vazio quando nada e permitido', () => {
    const result = pickAllowedFields({ hack: 1, evil: 2 });
    expect(result).toEqual({});
  });
});
