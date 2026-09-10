import { OrderStatus } from '@prisma/client';
import { DomainError } from './errors';

// Matriz de transicoes: para cada status, os destinos permitidos.
// ENTREGUE e CANCELADO sao terminais (lista vazia).
// Cancelar so antes do envio.
//
// REEMBOLSADO (Bloco 7b) entra SO a partir de PAGO, e so no estorno INTEGRAL.
// Estorno PARCIAL nao transiciona: e atributo de VALOR (orders.refundedTotal),
// nao fase do pedido — mesma razao pela qual o payment-service mantem CAPTURED.
//
// ENVIADO e ENTREGUE NAO ganham aresta para REEMBOLSADO de proposito. Estorno
// integral de pedido ja expedido e uma DEVOLUCAO, que envolve logistica fisica
// que este sistema nao modela; mudar o status esconderia que ha mercadoria na
// rua. Esses casos registram PENDENCIA para triagem humana, mesma decisao do
// 6f, onde payment.expired nunca cancela pedido PAGO.
//
// CANCELADO nao ganha aresta: pedido cancelado que recebe estorno tem o
// refundedTotal movido — a aritmetica acontece sempre —, mas o status ja e
// terminal e nao ha transicao a declarar.
const TRANSICOES: Record<OrderStatus, OrderStatus[]> = {
  PENDENTE: [OrderStatus.PAGO, OrderStatus.CANCELADO],
  PAGO: [OrderStatus.ENVIADO, OrderStatus.CANCELADO, OrderStatus.REEMBOLSADO],
  ENVIADO: [OrderStatus.ENTREGUE],
  ENTREGUE: [],
  CANCELADO: [],
  REEMBOLSADO: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSICOES[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('TRANSICAO_INVALIDA');
  }
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSICOES[status].length === 0;
}

// Devolve uma COPIA: quem consome nao consegue mutar a matriz interna.
export function allowedTransitions(from: OrderStatus): OrderStatus[] {
  return [...TRANSICOES[from]];
}
