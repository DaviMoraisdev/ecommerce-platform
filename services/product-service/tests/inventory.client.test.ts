import { fetchAvailability } from '../src/services/inventory.client';

// Monta um Response mockado com o minimo que o client consome. O cast fica
// concentrado aqui — os testes chamam mockResponse(...) sem casts espalhados.
function mockResponse(opts: {
  status?: number;
  ok?: boolean;
  json?: () => Promise<unknown>;
}): Response {
  return {
    status: opts.status ?? 200,
    ok: opts.ok ?? true,
    json: opts.json ?? (async () => ({})),
  } as unknown as Response;
}

// Usa spyOn para restaurar global.fetch automaticamente com restoreAllMocks().
function spyFetch() {
  return jest.spyOn(globalThis, 'fetch');
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('fetchAvailability — sucesso e recalculo', () => {
  it('payload valido -> retorna StockAvailability com os campos certos', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: 10, reserved: 3 }) })
    );

    const result = await fetchAvailability('abc');

    expect(result).toEqual({ productId: 'abc', quantity: 10, reserved: 3, available: 7 });
  });

  it('available e RECALCULADO (quantity - reserved), ignorando o valor recebido', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: 10, reserved: 4, available: 999 }) })
    );

    const result = await fetchAvailability('abc');

    expect(result?.available).toBe(6); // 10 - 4, nao 999
  });
});

describe('fetchAvailability — respostas HTTP', () => {
  it('404 -> null', async () => {
    spyFetch().mockResolvedValue(mockResponse({ status: 404, ok: false }));
    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('non-OK (500) -> null', async () => {
    spyFetch().mockResolvedValue(mockResponse({ status: 500, ok: false }));
    expect(await fetchAvailability('abc')).toBeNull();
  });
});

describe('fetchAvailability — falhas de rede e timeout', () => {
  it('passa um AbortSignal ao fetch (prova que o timeout esta configurado)', async () => {
    const spy = spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: 1, reserved: 0 }) })
    );

    await fetchAvailability('abc');

    const options = spy.mock.calls[0][1];
    expect(options).toBeDefined();
    expect(options?.signal).toBeDefined();
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborta e retorna null quando o fetch nao responde a tempo', async () => {
    jest.useFakeTimers();

    // fetch que so rejeita quando o signal for abortado — simula chamada pendurada.
    const spy = spyFetch().mockImplementation((_url, opts?: any) => {
      return new Promise((_resolve, reject) => {
        const signal = opts?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const promise = fetchAvailability('abc');
    // Avanca bem mais que qualquer timeout razoavel: o teste prova que o abort
    // DISPARA, sem depender do valor exato do timeout interno do client.
    jest.advanceTimersByTime(10000);

    const result = await promise;
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('erro de rede (fetch rejeita) -> null', async () => {
    spyFetch().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchAvailability('abc')).toBeNull();
  });
});

describe('fetchAvailability — payload malformado', () => {
  it('JSON invalido (corpo nao parseavel) -> null', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => { throw new Error('Unexpected token'); } })
    );
    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('campo obrigatorio ausente (sem reserved) -> null', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: 10 }) })
    );
    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('tipo errado (quantity string) -> null', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: 'dez', reserved: 0 }) })
    );
    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('quantity negativo -> null', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: -5, reserved: 0 }) })
    );
    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('reserved negativo -> null', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: 10, reserved: -2 }) })
    );
    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('quantity NaN -> null (Number.isFinite rejeita)', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: NaN, reserved: 0 }) })
    );
    expect(await fetchAvailability('abc')).toBeNull();
  });

  it('reserved > quantity -> null (regra que impede available negativo)', async () => {
    spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'abc', quantity: 5, reserved: 10 }) })
    );
    expect(await fetchAvailability('abc')).toBeNull();
  });
});

describe('fetchAvailability — URL e encoding', () => {
  it('chama a URL exata com o productId escapado, uma unica vez', async () => {
    const spy = spyFetch().mockResolvedValue(
      mockResponse({ json: async () => ({ productId: 'a/b', quantity: 1, reserved: 0 }) })
    );

    await fetchAvailability('a/b');

    const calledUrl = spy.mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:3004/stock/a%2Fb');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
