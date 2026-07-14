import { fetchProduct } from '../src/services/product.client';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function res(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

describe('product.client.fetchProduct', () => {
  beforeEach(() => mockFetch.mockReset());

  it('ok: retorna produto valido', async () => {
    mockFetch.mockResolvedValue(
      res(200, {
        _id: 'p1',
        name: 'Camisa',
        price: 50,
        availability: { available: 10, inStock: true },
      })
    );
    const r = await fetchProduct('p1');
    expect(r).toEqual({
      status: 'ok',
      product: {
        id: 'p1',
        name: 'Camisa',
        price: 50,
        availability: { available: 10, inStock: true },
      },
    });
  });

  it('ok com availability null (inventory fora) ainda retorna o produto', async () => {
    mockFetch.mockResolvedValue(
      res(200, { _id: 'p1', name: 'Camisa', price: 50, availability: null })
    );
    const r = await fetchProduct('p1');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.product.availability).toBeNull();
    }
  });

  it('not_found quando product-service responde 404', async () => {
    mockFetch.mockResolvedValue(res(404, { error: 'Produto nao encontrado' }));
    const r = await fetchProduct('inexistente');
    expect(r.status).toBe('not_found');
  });

  it('unavailable quando product-service responde 500', async () => {
    mockFetch.mockResolvedValue(res(500, {}));
    const r = await fetchProduct('p1');
    expect(r.status).toBe('unavailable');
  });

  it('unavailable quando o payload e invalido', async () => {
    mockFetch.mockResolvedValue(res(200, { foo: 'bar' }));
    const r = await fetchProduct('p1');
    expect(r.status).toBe('unavailable');
  });

  it('unavailable quando ha falha de rede/timeout', async () => {
    mockFetch.mockRejectedValue(new Error('network fail'));
    const r = await fetchProduct('p1');
    expect(r.status).toBe('unavailable');
  });
});
