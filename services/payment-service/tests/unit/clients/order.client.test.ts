import {
  OrderClient,
  OrderIndisponivelError,
  OrderNaoAutorizadoError,
  OrderNaoEncontradoError,
  OrderRespostaInvalidaError,
} from '../../../src/clients/order.client';

const BASE = 'http://order.local:3006';
const TOKEN = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.assinatura';

function pedidoValido(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ord_1',
    userId: 'usr_1',
    status: 'PENDENTE',
    total: '129.9',
    items: [
      { productId: 'p1', quantity: 2, unitPrice: '50', subtotal: '100' },
      { productId: 'p2', quantity: 1, unitPrice: '29.9', subtotal: '29.9' },
    ],
    ...overrides,
  };
}

/** fetch falso que devolve status e corpo controlados, e registra a chamada. */
function fetchQueResponde(
  status: number,
  corpo: unknown,
  registro?: { url?: string; init?: RequestInit },
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (registro) {
      registro.url = url;
      registro.init = init;
    }
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (typeof corpo === 'string' && corpo === '__NAO_JSON__') {
          throw new Error('Unexpected token');
        }
        return corpo;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** fetch que nunca resolve, mas honra o AbortSignal — como o fetch real. */
const fetchQueTrava: typeof fetch = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const erro = new Error('The operation was aborted');
      erro.name = 'AbortError';
      reject(erro);
    });
  })) as unknown as typeof fetch;

function cliente(fetchImpl: typeof fetch, timeoutMs = 5000): OrderClient {
  return new OrderClient({ baseUrl: BASE, timeoutMs, fetchImpl });
}

/**
 * Captura a rejeicao COM TIPO, e falha explicitamente se a chamada resolver.
 *
 * `.catch((e) => e)` tem dois problemas: o parametro fica implicitamente `any`,
 * e o tipo do resultado vira uniao entre o valor resolvido e o erro — entao
 * acessar `.retryable` nao compila. Alem disso, se a chamada resolvesse, a
 * asercao seguinte falharia com mensagem confusa em vez de dizer o que ocorreu.
 */
async function capturar(
  fn: () => Promise<unknown>,
): Promise<Error & { retryable?: boolean; motivo?: string }> {
  try {
    await fn();
  } catch (erro) {
    return erro as Error & { retryable?: boolean; motivo?: string };
  }
  throw new Error('esperava rejeicao, mas a chamada RESOLVEU');
}

describe('OrderClient — caminho feliz', () => {
  it('devolve o pedido com valores em CENTAVOS inteiros', async () => {
    const pedido = await cliente(fetchQueResponde(200, pedidoValido())).buscarPedido(
      'ord_1',
      TOKEN,
    );

    // "129.9" -> 12990: o Prisma descarta zeros a direita, e toCents cobre.
    expect(pedido.totalCents).toBe(12990);
    expect(pedido.items[0].unitPriceCents).toBe(5000);
    expect(pedido.items[0].subtotalCents).toBe(10000);
    expect(pedido.items[1].subtotalCents).toBe(2990);
    expect(pedido.status).toBe('PENDENTE');
  });

  it('REPASSA o Authorization exatamente como recebido', async () => {
    const registro: { url?: string; init?: RequestInit } = {};
    await cliente(fetchQueResponde(200, pedidoValido(), registro)).buscarPedido('ord_1', TOKEN);

    // Sem fabricar token: a checagem de dono acontece no order.
    expect((registro.init?.headers as Record<string, string>).Authorization).toBe(TOKEN);
  });

  it('monta a URL a partir da base, escapando o id', async () => {
    const registro: { url?: string; init?: RequestInit } = {};
    await cliente(fetchQueResponde(200, pedidoValido(), registro)).buscarPedido(
      'ord/../admin',
      TOKEN,
    );

    expect(registro.url).toBe(`${BASE}/orders/ord%2F..%2Fadmin`);
  });
});

describe('OrderClient — mapeamento de status HTTP', () => {
  it('401 vira OrderNaoAutorizadoError, sem retry', async () => {
    const erro = await capturar(() => cliente(fetchQueResponde(401, {})) .buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderNaoAutorizadoError);
    expect(erro.retryable).toBe(false);
  });

  it.each([404, 403])(
    '%i vira OrderNaoEncontradoError com mensagem INDISTINGUIVEL',
    async (status) => {
      const erro = await capturar(() => cliente(fetchQueResponde(status, {})) .buscarPedido('ord_1', TOKEN));

      expect(erro).toBeInstanceOf(OrderNaoEncontradoError);
      // O order devolve 404 tanto para inexistente quanto para pedido de outro,
      // para nao revelar existencia. Diferenciar aqui vazaria o que ele protege.
      expect(erro.message).toBe('Pedido nao encontrado');
    },
  );

  it.each([500, 502, 503, 504])('%i vira OrderIndisponivelError, com retry', async (status) => {
    const erro = await capturar(() => cliente(fetchQueResponde(status, {})) .buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderIndisponivelError);
    expect(erro.retryable).toBe(true);
  });

  it.each([400, 409, 418])('%i vira OrderRespostaInvalidaError, sem retry', async (status) => {
    const erro = await capturar(() => cliente(fetchQueResponde(status, {})) .buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderRespostaInvalidaError);
    expect(erro.retryable).toBe(false);
  });
});

describe('OrderClient — rede e timeout', () => {
  it('falha de rede vira OrderIndisponivelError', async () => {
    const fetchQueFalha = (async () => {
      const erro = new Error('connect ECONNREFUSED');
      erro.name = 'TypeError';
      throw erro;
    }) as unknown as typeof fetch;

    const erro = await capturar(() => cliente(fetchQueFalha).buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderIndisponivelError);
    expect(erro.retryable).toBe(true);
  });

  it('timeout aborta a chamada e cita o teto em ms', async () => {
    const erro = await capturar(() => cliente(fetchQueTrava, 25).buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderIndisponivelError);
    // O detalhe migrou de `message` para `motivo` no achado 3.3: a mensagem vai
    // no corpo da resposta ao cliente e nao pode carregar diagnostico interno.
    expect(erro.motivo).toContain('timeout de 25ms');
    expect(erro.message).not.toContain('timeout');
    expect(erro.retryable).toBe(true);
  });
});

describe('OrderClient — validacao da resposta', () => {
  it('corpo que nao e JSON vira OrderRespostaInvalidaError', async () => {
    const erro = await capturar(() => cliente(fetchQueResponde(200, '__NAO_JSON__')) .buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderRespostaInvalidaError);
  });

  it.each([
    ['corpo nao e objeto', 'texto'],
    ['corpo e array', []],
    ['corpo e null', null],
  ])('recusa %s', async (_rotulo, corpo) => {
    const erro = await capturar(() => cliente(fetchQueResponde(200, corpo)) .buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderRespostaInvalidaError);
  });

  it.each([
    ['id vazio', { id: '   ' }],
    ['id ausente', { id: undefined }],
    ['userId ausente', { userId: undefined }],
    ['status ausente', { status: undefined }],
    ['items nao e array', { items: {} }],
    ['items vazio', { items: [] }],
    ['total com tres casas decimais', { total: '12.295' }],
    ['total nao numerico', { total: 'abc' }],
    ['total negativo', { total: '-1' }],
  ])('recusa %s, citando o campo', async (_rotulo, override) => {
    const erro = await capturar(() => cliente(fetchQueResponde(200, pedidoValido(override))) .buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderRespostaInvalidaError);
  });

  it.each([
    ['quantity zero', { quantity: 0 }],
    ['quantity fracionaria', { quantity: 1.5 }],
    ['quantity negativa', { quantity: -1 }],
    ['quantity string', { quantity: '2' }],
    ['unitPrice invalido', { unitPrice: 'x' }],
    ['subtotal com tres casas', { subtotal: '1.005' }],
    ['productId vazio', { productId: '' }],
  ])('recusa item com %s', async (_rotulo, override) => {
    const corpo = pedidoValido({
      items: [{ productId: 'p1', quantity: 2, unitPrice: '50', subtotal: '100', ...override }],
    });

    const erro = await capturar(() => cliente(fetchQueResponde(200, corpo)) .buscarPedido('ord_1', TOKEN));

    expect(erro).toBeInstanceOf(OrderRespostaInvalidaError);
    expect(erro.message).toContain('items[0]');
  });
});

describe('OrderClient — achados do review do PR #52', () => {
  /** Entrega os cabecalhos na hora e TRAVA no corpo, ate o signal abortar. */
  const fetchComCorpoTravado = (async (_url: string, init?: { signal?: AbortSignal }) => ({
    status: 200,
    ok: true,
    json: () =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(
            Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
          );
        });
      }),
  })) as unknown as typeof fetch;

  /** Formato real de falha de rede no Node: TypeError com a causa aninhada. */
  const fetchComRecusaDeConexao = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  }) as unknown as typeof fetch;

  it(
    'aplica o timeout tambem a LEITURA DO CORPO, nao so aos cabecalhos',
    async () => {
      // ANTES da correcao este teste falhava por ESTOURO DE TEMPO, nao por
      // assercao: `fetch()` resolve nos cabecalhos, o clearTimeout ficava logo
      // depois dele, o abort nunca disparava e a promessa nunca se resolvia.
      // Um vermelho aqui com "Exceeded timeout" significa regressao do
      // temporizador, nao teste lento.
      const erro = await capturar(() =>
        cliente(fetchComCorpoTravado, 50).buscarPedido('ord_1', TOKEN),
      );

      expect(erro).toBeInstanceOf(OrderIndisponivelError);
      expect(erro.motivo).toContain('lendo o corpo');
      expect(erro.retryable).toBe(true);
    },
    1000,
  );

  it('reporta a CAUSA da falha de rede e nao vaza topologia ao cliente', async () => {
    const erro = await capturar(() =>
      cliente(fetchComRecusaDeConexao, 50).buscarPedido('ord_1', TOKEN),
    );

    // Para o operador: a causa util. O smoke do Bloco 3 media "TypeError" aqui,
    // que nao orienta ninguem de plantao.
    expect(erro.motivo).toBe('ECONNREFUSED');
    // Para o cliente: nada de nome de servico interno nem de detalhe de rede.
    expect(erro.message).not.toContain('order-service');
    expect(erro.message).not.toContain('ECONNREFUSED');
    expect(erro.message).not.toContain('TypeError');
  });
});
