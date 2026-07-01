import { fetchAvailability } from '../src/services/inventory.client';

// Helper: monta um objeto Response mockado com o minimo que o client consome.
function mockResponse(opts: {
  status?: number;
  ok?: boolean;
  json?: () => Promise<unknown>;
}) {
  return {
    status: opts.status ?? 200,
    ok: opts.ok ?? true,
    json: opts.json ?? (async () => ({})),
  };
}

// Substitui o fetch global antes de cada teste; restaura depois.
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('fetchAvailability — sucesso e recalculo', () => {
  it('payload valido -> retorna StockAvailability com os campos certos', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        json: async () => ({ productId: 'abc', quantity: 10, reserved: 3 }),
      })
    ) as any;

    const result = await fetchAvailability('abc');

    expect(result).toEqual({
      productId: 'abc',
      quantity: 10,
      reserved: 3,
      available: 7,
    });
  });

  it('available e RECALCULADO (quantity - reserved), ignorando o valor recebido', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        // available enviado como 999 (mentiroso) — deve ser ignorado.
        json: async () => ({ productId: 'abc', quantity: 10, reserved: 4, available: 999 }),
      })
    ) as any;

    const result = await fetchAvailability('abc');

    expect(result?.available).toBe(6); // 10 - 4, nao 999
  });
});

describe('fetchAvailability — respostas HTTP', () => {
  it('404 -> null', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ status: 404, ok: false })
    ) as any;

    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('non-OK (500) -> null', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ status: 500, ok: false })
    ) as any;

    expect(await fetchAvailability('abc')).toBeNull();
  });
});

describe('fetchAvailability — falhas de rede', () => {
  it('timeout/abort -> null', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(abortErr) as any;

    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('erro de rede (fetch rejeita) -> null', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;

    expect(await fetchAvailability('abc')).toBeNull();
  });
});

describe('fetchAvailability — payload malformado', () => {
  it('JSON invalido (corpo nao parseavel) -> null', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        json: async () => {
          throw new Error('Unexpected token');
        },
      })
    ) as any;

    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('schema invalido (campos faltando/tipo errado) -> null', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        json: async () => ({ productId: 'abc', quantity: 'dez' }), // tipo errado, sem reserved
      })
    ) as any;

    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('reserved > quantity -> null (regra que impede available negativo)', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        json: async () => ({ productId: 'abc', quantity: 5, reserved: 10 }),
      })
    ) as any;

    expect(await fetchAvailability('abc')).toBeNull();
  });
});

describe('fetchAvailability — encoding da URL', () => {
  it('escapa caractere especial no productId', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      mockResponse({
        json: async () => ({ productId: 'a/b', quantity: 1, reserved: 0 }),
      })
    );
    global.fetch = fetchMock as any;

    await fetchAvailability('a/b');

    // A URL chamada deve conter o id escapado (a%2Fb), nao a barra crua.
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('a%2Fb');
    expect(calledUrl).not.toContain('/stock/a/b');
  });
});
