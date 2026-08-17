import { PaymentStatus } from '@prisma/client';

import { CHARGE_STATES, type ChargeState } from '../../../src/providers/payment-provider.port';
import {
  assertTransicao,
  estaTerminal,
  mapearEstadoDoProvedor,
  podeTransicionar,
  TransicaoDeStatusInvalidaError,
} from '../../../src/domain/payment-status';

const TODOS = Object.values(PaymentStatus);
// Anotado como PaymentStatus[] de proposito: inferido, o array viraria o subtipo
// estreito dos tres, e `includes` recusaria comparar com os outros quatro.
const TERMINAIS: PaymentStatus[] = [
  PaymentStatus.CAPTURED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELED,
];

describe('estaTerminal', () => {
  it.each(TERMINAIS)('%s e terminal', (status) => {
    expect(estaTerminal(status)).toBe(true);
  });

  it.each(TODOS.filter((s) => !TERMINAIS.includes(s)))('%s NAO e terminal', (status) => {
    expect(estaTerminal(status)).toBe(false);
  });
});

describe('podeTransicionar — propriedades da tabela', () => {
  it.each(TODOS)('%s tem entrada na tabela', (status) => {
    // Se a chave faltasse, TRANSICOES[de].has lancaria. O Record<PaymentStatus, ...>
    // ja garante isso em compilacao; aqui e a rede em runtime.
    expect(() => podeTransicionar(status, PaymentStatus.CANCELED)).not.toThrow();
  });

  it.each(TODOS)('%s -> ele mesmo e sempre permitido', (status) => {
    // Replay de evento nao e transicao. A entrega do broker e at-least-once por
    // desenho, entao o Bloco 4 recebera o mesmo evento duas vezes.
    expect(podeTransicionar(status, status)).toBe(true);
  });

  it.each(TERMINAIS)('%s nao tem saida para nenhum outro estado', (terminal) => {
    const saidas = TODOS.filter((outro) => outro !== terminal).filter((outro) =>
      podeTransicionar(terminal, outro),
    );
    expect(saidas).toEqual([]);
  });
});

describe('podeTransicionar — transicoes do fluxo', () => {
  it.each([
    [PaymentStatus.PENDING, PaymentStatus.PROCESSING],
    [PaymentStatus.PENDING, PaymentStatus.CAPTURED],
    [PaymentStatus.PENDING, PaymentStatus.FAILED],
    [PaymentStatus.PROCESSING, PaymentStatus.CAPTURED],
    [PaymentStatus.PROCESSING, PaymentStatus.FAILED],
    [PaymentStatus.PROCESSING, PaymentStatus.EXPIRED],
  ])('permite %s -> %s', (de, para) => {
    expect(podeTransicionar(de, para)).toBe(true);
  });

  /**
   * FAILED nao e terminal, e isso e consequencia direta da decisao 5 da fase:
   * cartao recusado mantem a janela de retentativa aberta, e a nova tentativa e
   * do MESMO Payment (orderId e unique no schema). Se FAILED fosse terminal, a
   * janela seria inexpressavel.
   */
  it.each([PaymentStatus.PROCESSING, PaymentStatus.CAPTURED])(
    'permite FAILED -> %s, porque a janela de retentativa continua aberta',
    (para) => {
      expect(podeTransicionar(PaymentStatus.FAILED, para)).toBe(true);
    },
  );

  it.each([
    [PaymentStatus.CAPTURED, PaymentStatus.FAILED],
    [PaymentStatus.CAPTURED, PaymentStatus.PROCESSING],
    [PaymentStatus.EXPIRED, PaymentStatus.CAPTURED],
    [PaymentStatus.CANCELED, PaymentStatus.PROCESSING],
    [PaymentStatus.PROCESSING, PaymentStatus.PENDING],
    [PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED],
  ])('recusa %s -> %s', (de, para) => {
    expect(podeTransicionar(de, para)).toBe(false);
  });

  /**
   * CAPTURED e terminal porque reembolso NAO muda o status: e aritmetica sobre
   * refundedAmountCents (decisao 9 da fase). Se alguem "corrigir" isso
   * adicionando REFUNDED ao enum, este teste e o comentario explicam o porque.
   */
  it('CAPTURED e terminal: reembolso e aritmetica, nao mudanca de estado', () => {
    expect(estaTerminal(PaymentStatus.CAPTURED)).toBe(true);
  });
});

describe('assertTransicao', () => {
  it('nao lanca para transicao valida', () => {
    expect(() =>
      assertTransicao(PaymentStatus.PENDING, PaymentStatus.PROCESSING),
    ).not.toThrow();
  });

  it('lanca citando os DOIS estados, para o log dizer o que foi tentado', () => {
    let capturado: unknown;
    try {
      assertTransicao(PaymentStatus.CAPTURED, PaymentStatus.FAILED);
    } catch (erro) {
      capturado = erro;
    }

    expect(capturado).toBeInstanceOf(TransicaoDeStatusInvalidaError);
    expect((capturado as Error).message).toContain('CAPTURED');
    expect((capturado as Error).message).toContain('FAILED');
  });
});

describe('mapearEstadoDoProvedor', () => {
  it.each([
    ['PROCESSING', PaymentStatus.PROCESSING],
    ['SUCCEEDED', PaymentStatus.CAPTURED],
    ['DECLINED', PaymentStatus.FAILED],
    ['CANCELED', PaymentStatus.CANCELED],
  ] as Array<[ChargeState, PaymentStatus]>)('mapeia %s -> %s', (provedor, nosso) => {
    expect(mapearEstadoDoProvedor(provedor)).toBe(nosso);
  });

  it('cobre TODOS os ChargeState da porta', () => {
    // Se a porta ganhar um estado, o switch exaustivo quebra a compilacao. Este
    // teste e a rede em runtime, usando a lista derivada do proprio tipo.
    for (const state of CHARGE_STATES) {
      expect(TODOS).toContain(mapearEstadoDoProvedor(state));
    }
  });

  /**
   * Nenhum estado do provedor mapeia para AUTHORIZED nem EXPIRED, e isso e
   * intencional: AUTHORIZED nao ocorre sob captura automatica (decisao 10), e
   * EXPIRED e decisao NOSSA, tomada pelo job do Bloco 6 — o provedor nao tem
   * como reportar que a nossa janela esgotou.
   */
  it.each([PaymentStatus.AUTHORIZED, PaymentStatus.EXPIRED])(
    'nenhum ChargeState mapeia para %s',
    (naoAlcancavel) => {
      const mapeados = CHARGE_STATES.map((s) => mapearEstadoDoProvedor(s));
      expect(mapeados).not.toContain(naoAlcancavel);
    },
  );
});
