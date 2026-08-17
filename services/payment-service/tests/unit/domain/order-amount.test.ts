import type { PedidoDoOrder } from '../../../src/clients/order.client';
import {
  PedidoNaoCobravelError,
  resolverValorDoPedido,
  ValorDoPedidoInvalidoError,
} from '../../../src/domain/order-amount';

function pedido(overrides: Partial<PedidoDoOrder> = {}): PedidoDoOrder {
  return {
    id: 'ord_1',
    userId: 'usr_1',
    status: 'PENDENTE',
    totalCents: 12990,
    items: [
      { productId: 'p1', quantity: 2, unitPriceCents: 5000, subtotalCents: 10000 },
      { productId: 'p2', quantity: 1, unitPriceCents: 2990, subtotalCents: 2990 },
    ],
    ...overrides,
  };
}

describe('resolverValorDoPedido — caminho valido', () => {
  it('devolve o total em centavos quando tudo bate', () => {
    expect(resolverValorDoPedido(pedido())).toBe(12990);
  });

  it('aceita pedido de um item so', () => {
    expect(
      resolverValorDoPedido(
        pedido({
          totalCents: 500,
          items: [{ productId: 'p1', quantity: 1, unitPriceCents: 500, subtotalCents: 500 }],
        }),
      ),
    ).toBe(500);
  });
});

describe('resolverValorDoPedido — status', () => {
  it.each(['PAGO', 'ENVIADO', 'ENTREGUE', 'CANCELADO'])(
    'recusa cobrar pedido em %s',
    (status) => {
      expect(() => resolverValorDoPedido(pedido({ status }))).toThrow(PedidoNaoCobravelError);
    },
  );

  it('a mensagem diz o status atual e o exigido', () => {
    expect(() => resolverValorDoPedido(pedido({ status: 'PAGO' }))).toThrow(/PAGO.*PENDENTE/);
  });
});

describe('resolverValorDoPedido — divergencia de valor', () => {
  it('recusa quando a soma dos subtotais nao bate com o total', () => {
    expect(() => resolverValorDoPedido(pedido({ totalCents: 12991 }))).toThrow(
      ValorDoPedidoInvalidoError,
    );
  });

  it('a mensagem mostra os DOIS valores, para o operador comparar', () => {
    expect(() => resolverValorDoPedido(pedido({ totalCents: 12991 }))).toThrow(/129\.91.*129\.90/);
  });

  it('recusa item cujo subtotal nao e quantidade x preco unitario', () => {
    expect(() =>
      resolverValorDoPedido(
        pedido({
          totalCents: 9999,
          items: [{ productId: 'p1', quantity: 3, unitPriceCents: 1000, subtotalCents: 9999 }],
        }),
      ),
    ).toThrow(/items\[0\]/);
  });

  /**
   * O caso que justifica a checagem por item existir.
   *
   * Dois itens errados em direcoes opostas: o primeiro cobra 15,00 de subtotal
   * para 1 x 5,00, o segundo cobra 5,00 para 1 x 15,00. A SOMA fecha com o total,
   * entao verificar apenas Σ subtotais aprovaria a cobranca.
   */
  it('pega compensacao entre itens que a soma total esconderia', () => {
    const compensado = pedido({
      totalCents: 2000,
      items: [
        { productId: 'p1', quantity: 1, unitPriceCents: 500, subtotalCents: 1500 },
        { productId: 'p2', quantity: 1, unitPriceCents: 1500, subtotalCents: 500 },
      ],
    });

    const soma = compensado.items.reduce((s, i) => s + i.subtotalCents, 0);
    expect(soma).toBe(compensado.totalCents); // a soma FECHA

    expect(() => resolverValorDoPedido(compensado)).toThrow(/items\[0\]/);
  });

  it('recusa total zero', () => {
    expect(() =>
      resolverValorDoPedido(
        pedido({
          totalCents: 0,
          items: [{ productId: 'p1', quantity: 1, unitPriceCents: 0, subtotalCents: 0 }],
        }),
      ),
    ).toThrow(/maior que zero/);
  });
});
