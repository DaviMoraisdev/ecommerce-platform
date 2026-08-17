import { assertValidCents, toCents, MoneyError } from '../domain/money';

/**
 * Cliente do order-service.
 *
 * AUTENTICACAO: repassa o `Authorization` do usuario, em vez de fabricar um JWT
 * de ADMIN com o segredo compartilhado (padrao usado em order -> inventory, que
 * e excecao de seguranca registrada para a Fase 7). Repassando, a checagem de
 * dono acontece no servico que possui o dado, e nao ha token forjado.
 *
 * FRONTEIRA: a resposta e validada em runtime. O order e nosso, mas e outro
 * deployable atras da rede — a mesma disciplina do fake.wire.ts vale aqui.
 */

export class OrderNaoEncontradoError extends Error {
  readonly retryable = false;
  constructor() {
    // Mensagem DELIBERADAMENTE indistinguivel. O order devolve 404 tanto para
    // pedido inexistente quanto para pedido de outro usuario, para nao revelar
    // existencia. Diferenciar aqui vazaria o que ele protege.
    super('Pedido nao encontrado');
    this.name = 'OrderNaoEncontradoError';
  }
}

export class OrderNaoAutorizadoError extends Error {
  readonly retryable = false;
  constructor() {
    super('Token invalido ou expirado');
    this.name = 'OrderNaoAutorizadoError';
  }
}

export class OrderIndisponivelError extends Error {
  readonly retryable = true;
  constructor(motivo: string) {
    super(`order-service indisponivel: ${motivo}`);
    this.name = 'OrderIndisponivelError';
  }
}

export class OrderRespostaInvalidaError extends Error {
  readonly retryable = false;
  constructor(motivo: string) {
    super(`resposta do order-service invalida: ${motivo}`);
    this.name = 'OrderRespostaInvalidaError';
  }
}

export interface ItemDoPedido {
  productId: string;
  quantity: number;
  /** Centavos inteiros, ja convertidos e validados. */
  unitPriceCents: number;
  subtotalCents: number;
}

export interface PedidoDoOrder {
  id: string;
  userId: string;
  status: string;
  /** Centavos inteiros, ja convertidos e validados. */
  totalCents: number;
  items: ItemDoPedido[];
}

export interface OrderClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Injetavel para teste; default e o fetch global do Node. */
  fetchImpl?: typeof fetch;
}

function invalida(motivo: string): never {
  throw new OrderRespostaInvalidaError(motivo);
}

function texto(valor: unknown, campo: string): string {
  if (typeof valor !== 'string' || valor.trim() === '') {
    invalida(`${campo} deve ser string nao vazia`);
  }
  return valor;
}

function centavos(valor: unknown, campo: string): number {
  if (typeof valor !== 'string' && typeof valor !== 'number') {
    invalida(`${campo} deve ser string ou number`);
  }
  try {
    // toCents rejeita perda de precisao: "129.9" -> 12990, "12.295" -> erro.
    const cents = toCents(valor as string | number);
    assertValidCents(cents);
    return cents;
  } catch (erro) {
    if (erro instanceof MoneyError) invalida(`${campo}: ${erro.message}`);
    throw erro;
  }
}

function quantidade(valor: unknown, campo: string): number {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < 1) {
    invalida(`${campo} deve ser inteiro seguro maior que zero`);
  }
  return valor;
}

function traduzir(bruto: unknown): PedidoDoOrder {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) {
    invalida('corpo nao e um objeto');
  }
  const p = bruto as Record<string, unknown>;

  if (!Array.isArray(p.items)) invalida('items deve ser um array');
  if (p.items.length === 0) invalida('pedido sem itens');

  const items = p.items.map((bruto_item, i) => {
    if (typeof bruto_item !== 'object' || bruto_item === null) {
      invalida(`items[${i}] nao e um objeto`);
    }
    const item = bruto_item as Record<string, unknown>;
    return {
      productId: texto(item.productId, `items[${i}].productId`),
      quantity: quantidade(item.quantity, `items[${i}].quantity`),
      unitPriceCents: centavos(item.unitPrice, `items[${i}].unitPrice`),
      subtotalCents: centavos(item.subtotal, `items[${i}].subtotal`),
    };
  });

  return {
    id: texto(p.id, 'id'),
    userId: texto(p.userId, 'userId'),
    status: texto(p.status, 'status'),
    totalCents: centavos(p.total, 'total'),
    items,
  };
}

export class OrderClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OrderClientOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Busca um pedido repassando o token do usuario.
   *
   * @param authorization valor bruto do cabecalho, incluindo o prefixo "Bearer ".
   */
  async buscarPedido(orderId: string, authorization: string): Promise<PedidoDoOrder> {
    const controle = new AbortController();
    const temporizador = setTimeout(() => controle.abort(), this.timeoutMs);

    let resposta: Response;
    try {
      resposta = await this.fetchImpl(
        `${this.baseUrl}/orders/${encodeURIComponent(orderId)}`,
        {
          method: 'GET',
          headers: { Authorization: authorization, Accept: 'application/json' },
          signal: controle.signal,
        },
      );
    } catch (erro) {
      const nome = (erro as Error)?.name;
      // AbortError e o timeout: transiente, e o chamador pode retentar.
      throw new OrderIndisponivelError(
        nome === 'AbortError' ? `timeout de ${this.timeoutMs}ms` : String(nome ?? 'falha de rede'),
      );
    } finally {
      clearTimeout(temporizador);
    }

    if (resposta.status === 401) throw new OrderNaoAutorizadoError();
    if (resposta.status === 404) throw new OrderNaoEncontradoError();
    if (resposta.status === 403) throw new OrderNaoEncontradoError();
    if (resposta.status >= 500) {
      throw new OrderIndisponivelError(`HTTP ${resposta.status}`);
    }
    if (!resposta.ok) {
      throw new OrderRespostaInvalidaError(`HTTP ${resposta.status}`);
    }

    let corpo: unknown;
    try {
      corpo = await resposta.json();
    } catch {
      throw new OrderRespostaInvalidaError('corpo nao e JSON valido');
    }

    return traduzir(corpo);
  }
}
