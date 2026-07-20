import { OrderStatus } from '@prisma/client';
import { DomainError } from './errors';

// Matriz de transicoes: para cada status, os destinos permitidos.
// ENTREGUE e CANCELADO sao terminais (lista vazia).
// Cancelar so antes do envio; logistica reversa/estorno seria outro fluxo.
const TRANSICOES: Record<OrderStatus, OrderStatus[]> = {
  PENDENTE: [OrderStatus.PAGO, OrderStatus.CANCELADO],
  PAGO: [OrderStatus.ENVIADO, OrderStatus.CANCELADO],
  ENVIADO: [OrderStatus.ENTREGUE],
  ENTREGUE: [],
  CANCELADO: [],
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
