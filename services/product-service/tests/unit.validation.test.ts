import { parsePositiveInt } from '../src/controllers/product.controller';
import { pickAllowedFields } from '../src/services/product.service';

describe('parsePositiveInt', () => {
  // Caminho feliz: string de digitos dentro do range vira numero.
  it('aceita um inteiro positivo valido', () => {
    expect(parsePositiveInt('5', 'page', 10000)).toBe(5);
  });

  it('aceita o limite inferior (1)', () => {
    expect(parsePositiveInt('1', 'page', 10000)).toBe(1);
  });

  it('aceita exatamente o maximo permitido', () => {
    expect(parsePositiveInt('50', 'limit', 50)).toBe(50);
  });

  // Ramos de rejeicao: cada um retorna objeto com .error (nao lanca).
  it('rejeita decimal', () => {
    const result = parsePositiveInt('2.5', 'limit', 50);
    expect(typeof result).toBe('object');
    expect((result as { error: string }).error).toContain('limit');
  });

  it('rejeita letras', () => {
    const result = parsePositiveInt('abc', 'page', 10000);
    expect(typeof result).toBe('object');
  });

  it('rejeita negativo', () => {
    // O regex de digitos ja barra o sinal de menos.
    const result = parsePositiveInt('-3', 'page', 10000);
    expect(typeof result).toBe('object');
  });

  it('rejeita zero (menor que 1)', () => {
    const result = parsePositiveInt('0', 'page', 10000);
    expect(typeof result).toBe('object');
    expect((result as { error: string }).error).toContain('1');
  });

  it('rejeita valor acima do maximo', () => {
    const result = parsePositiveInt('51', 'limit', 50);
    expect(typeof result).toBe('object');
    expect((result as { error: string }).error).toContain('maximo');
  });

  it('rejeita string vazia', () => {
    const result = parsePositiveInt('', 'page', 10000);
    expect(typeof result).toBe('object');
  });
});

describe('pickAllowedFields', () => {
  // Mantem apenas os campos da allowlist.
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

  // O teste central de seguranca: active NUNCA passa, mesmo se enviado.
  it('descarta o campo active', () => {
    const result = pickAllowedFields({ name: 'P', active: false });
    expect(result).not.toHaveProperty('active');
    expect(result).toHaveProperty('name', 'P');
  });

  // Qualquer campo fora da allowlist e ignorado (ex: tentativa de injetar _id).
  it('descarta campos arbitrarios fora da allowlist', () => {
    const result = pickAllowedFields({ name: 'P', _id: 'hack', role: 'ADMIN' });
    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('role');
    expect(result).toHaveProperty('name', 'P');
  });

  // Campos undefined nao entram (evita sobrescrever com undefined num update).
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
