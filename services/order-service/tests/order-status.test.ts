import { OrderStatus } from '@prisma/client';
import {
  canTransition,
  assertTransition,
  isTerminal,
  allowedTransitions,
} from '../src/domain/order-status';

// Derivado do enum: um status novo entra AUTOMATICAMENTE na varredura,
// forcando o teste a se posicionar sobre ele (a lista VALIDAS segue manual,
// para permanecer independente da implementacao).
const TODOS: OrderStatus[] = Object.values(OrderStatus);

// Fonte de verdade DO TESTE, escrita de forma independente da implementacao:
// se o teste apenas reimportasse a matriz, nao provaria nada.
const VALIDAS: Array<[OrderStatus, OrderStatus]> = [
  [OrderStatus.PENDENTE, OrderStatus.PAGO],
  [OrderStatus.PENDENTE, OrderStatus.CANCELADO],
  [OrderStatus.PAGO, OrderStatus.ENVIADO],
  [OrderStatus.PAGO, OrderStatus.CANCELADO],
  // Bloco 7b: UNICA aresta nova. ENVIADO e ENTREGUE nao entram — estorno de
  // pedido expedido e devolucao, com logistica que o sistema nao modela.
  [OrderStatus.PAGO, OrderStatus.REEMBOLSADO],
  [OrderStatus.ENVIADO, OrderStatus.ENTREGUE],
];

function ehValida(from: OrderStatus, to: OrderStatus): boolean {
  return VALIDAS.some(([f, t]) => f === from && t === to);
}

describe('maquina de estados do pedido', () => {
  it('cobre a matriz 6x6 completa (36 combinacoes)', () => {
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
