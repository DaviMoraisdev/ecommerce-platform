import type { PedidoDoOrder } from '../clients/order.client';
import { assertValidCents, fromCents } from './money';

/**
 * Resolve o valor a cobrar de um pedido.
 *
 * O payment NAO confia no campo `total` que veio pela rede: ele recalcula
 * Σ subtotais e exige que os dois batam. E a mesma regra que o order aplica no
 * checkout — "total recalculado no servidor, nunca o valor que veio do cliente" —
 * aplicada de novo um servico depois.
 *
 * Se divergirem, ha bug em algum dos dois lados e a cobranca NAO sai. Preferimos
 * um pagamento que nao acontece a um pagamento com valor errado.
 */

export class ValorDoPedidoInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValorDoPedidoInvalidoError';
  }
}

export class PedidoNaoCobravelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PedidoNaoCobravelError';
  }
}

/** So pedido PENDENTE aceita cobranca. PAGO, ENVIADO, ENTREGUE, CANCELADO nao. */
const STATUS_COBRAVEL = 'PENDENTE';

export function resolverValorDoPedido(pedido: PedidoDoOrder): number {
  if (pedido.status !== STATUS_COBRAVEL) {
    throw new PedidoNaoCobravelError(
      `pedido em ${pedido.status}; somente ${STATUS_COBRAVEL} aceita cobranca`,
    );
  }

  const somaDosSubtotais = pedido.items.reduce((soma, item) => soma + item.subtotalCents, 0);

  // Inteiros em centavos: a soma e exata, sem tolerancia de arredondamento.
  // Qualquer diferenca e divergencia real, nao imprecisao de ponto flutuante.
  if (somaDosSubtotais !== pedido.totalCents) {
    throw new ValorDoPedidoInvalidoError(
      `total do pedido (${fromCents(pedido.totalCents)}) nao bate com a soma dos ` +
        `subtotais (${fromCents(somaDosSubtotais)})`,
    );
  }

  // Coerencia por item: quantidade x preco unitario deve dar o subtotal.
  for (const [i, item] of pedido.items.entries()) {
    const esperado = item.unitPriceCents * item.quantity;
    if (esperado !== item.subtotalCents) {
      throw new ValorDoPedidoInvalidoError(
        `items[${i}]: ${item.quantity} x ${fromCents(item.unitPriceCents)} = ` +
          `${fromCents(esperado)}, mas subtotal e ${fromCents(item.subtotalCents)}`,
      );
    }
  }

  if (pedido.totalCents <= 0) {
    throw new ValorDoPedidoInvalidoError('total do pedido deve ser maior que zero');
  }

  assertValidCents(pedido.totalCents);
  return pedido.totalCents;
}
