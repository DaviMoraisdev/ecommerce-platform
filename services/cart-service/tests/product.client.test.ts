import { fetchProduct } from '../src/services/product.client';

function res(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('product.client.fetchProduct', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('ok: retorna produto valido', async () => {
    fetchSpy.mockResolvedValue(
      res(200, {
        _id: 'p1',
        name: 'Camisa',
        price: 50,
        availability: { available: 10, inStock: true },
      }) as any
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

  it('ok com availability null', async () => {
    fetchSpy.mockResolvedValue(
      res(200, { _id: 'p1', name: 'Camisa', price: 50, availability: null }) as any
    );
    expect((await fetchProduct('p1')).status).toBe('ok');
  });

  it('not_found quando 404', async () => {
    fetchSpy.mockResolvedValue(res(404, { error: 'x' }) as any);
    expect((await fetchProduct('x')).status).toBe('not_found');
  });

  it('not_found quando 400 (id malformado, servico saudavel)', async () => {
    fetchSpy.mockResolvedValue(res(400, { error: 'ID invalido' }) as any);
    expect((await fetchProduct('p1')).status).toBe('not_found');
  });

  it('unavailable quando 500', async () => {
    fetchSpy.mockResolvedValue(res(500, {}) as any);
    expect((await fetchProduct('p1')).status).toBe('unavailable');
  });

  it('unavailable quando payload totalmente invalido', async () => {
    fetchSpy.mockResolvedValue(res(200, { foo: 'bar' }) as any);
    expect((await fetchProduct('p1')).status).toBe('unavailable');
  });

  it('unavailable quando available e NaN', async () => {
    fetchSpy.mockResolvedValue(
      res(200, { _id: 'p1', name: 'x', price: 10, availability: { available: NaN, inStock: true } }) as any
    );
    expect((await fetchProduct('p1')).status).toBe('unavailable');
  });

  it('unavailable quando available e negativo', async () => {
    fetchSpy.mockResolvedValue(
      res(200, { _id: 'p1', name: 'x', price: 10, availability: { available: -1, inStock: true } }) as any
    );
    expect((await fetchProduct('p1')).status).toBe('unavailable');
  });

  it('unavailable quando inStock nao e booleano', async () => {
    fetchSpy.mockResolvedValue(
      res(200, { _id: 'p1', name: 'x', price: 10, availability: { available: 5, inStock: 'sim' } }) as any
    );
    expect((await fetchProduct('p1')).status).toBe('unavailable');
  });

  it('unavailable quando ha falha de rede', async () => {
    fetchSpy.mockRejectedValue(new Error('network'));
    expect((await fetchProduct('p1')).status).toBe('unavailable');
  });

  it('unavailable no timeout: AbortController dispara apos TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    fetchSpy.mockImplementation(
      ((_url: any, opts: any) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        })) as any
    );
    const p = fetchProduct('p1');
    await jest.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.status).toBe('unavailable');
  });
});
