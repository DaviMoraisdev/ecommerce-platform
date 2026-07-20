import { OrderStatus } from '@prisma/client';
import {
  canTransition,
  assertTransition,
  isTerminal,
  allowedTransitions,
} from '../src/domain/order-status';

const TODOS: OrderStatus[] = [
  OrderStatus.PENDENTE,
  OrderStatus.PAGO,
  OrderStatus.ENVIADO,
  OrderStatus.ENTREGUE,
  OrderStatus.CANCELADO,
];

// Fonte de verdade DO TESTE, escrita de forma independente da implementacao:
// se o teste apenas reimportasse a matriz, nao provaria nada.
const VALIDAS: Array<[OrderStatus, OrderStatus]> = [
  [OrderStatus.PENDENTE, OrderStatus.PAGO],
  [OrderStatus.PENDENTE, OrderStatus.CANCELADO],
  [OrderStatus.PAGO, OrderStatus.ENVIADO],
  [OrderStatus.PAGO, OrderStatus.CANCELADO],
  [OrderStatus.ENVIADO, OrderStatus.ENTREGUE],
];

function ehValida(from: OrderStatus, to: OrderStatus): boolean {
  return VALIDAS.some(([f, t]) => f === from && t === to);
}

describe('maquina de estados do pedido', () => {
  it('cobre a matriz 5x5 completa (25 combinacoes)', () => {
    for (const from of TODOS) {
      for (const to of TODOS) {
        expect([from, to, canTransition(from, to)]).toEqual([
          from,
          to,
          ehValida(from, to),
        ]);
      }
    }
  });

  it('nenhum status transiciona para si mesmo', () => {
    for (const s of TODOS) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('ENTREGUE e CANCELADO sao terminais; os demais nao', () => {
    expect(isTerminal(OrderStatus.ENTREGUE)).toBe(true);
    expect(isTerminal(OrderStatus.CANCELADO)).toBe(true);
    expect(isTerminal(OrderStatus.PENDENTE)).toBe(false);
    expect(isTerminal(OrderStatus.PAGO)).toBe(false);
    expect(isTerminal(OrderStatus.ENVIADO)).toBe(false);
  });

  it('assertTransition passa na valida e lanca TRANSICAO_INVALIDA no pulo', () => {
    expect(() =>
      assertTransition(OrderStatus.PENDENTE, OrderStatus.PAGO)
    ).not.toThrow();
    expect(() =>
      assertTransition(OrderStatus.PENDENTE, OrderStatus.ENVIADO)
    ).toThrow('TRANSICAO_INVALIDA');
    expect(() =>
      assertTransition(OrderStatus.ENTREGUE, OrderStatus.PENDENTE)
    ).toThrow('TRANSICAO_INVALIDA');
  });

  it('allowedTransitions devolve copia (nao permite mutar a matriz)', () => {
    const lista = allowedTransitions(OrderStatus.PENDENTE);
    lista.push(OrderStatus.ENTREGUE);
    expect(allowedTransitions(OrderStatus.PENDENTE)).not.toContain(
      OrderStatus.ENTREGUE
    );
  });
});
