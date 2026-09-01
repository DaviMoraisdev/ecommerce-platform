import { PaymentStatus, Prisma, type Payment, type PrismaClient } from '@prisma/client';

import type { OrderClient, PedidoDoOrder } from '../../src/clients/order.client';

export const AGORA = new Date('2026-08-17T12:00:00.000Z');

/** 2 x 6495 = 12990: subtotal e total coerentes, como resolverValorDoPedido exige. */
export function pedidoDeTeste(overrides: Partial<PedidoDoOrder> = {}): PedidoDoOrder {
  return {
    id: 'ord_1',
    userId: 'usr_1',
    status: 'PENDENTE',
    totalCents: 12990,
    items: [
      { productId: 'prod_1', quantity: 2, unitPriceCents: 6495, subtotalCents: 12990 },
    ],
    ...overrides,
  };
}

export function paymentDeTeste(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1',
    orderId: 'ord_1',
    userId: 'usr_1',
    status: PaymentStatus.PENDING,
    amountCents: 12990,
    capturedAmountCents: 0,
    refundedAmountCents: 0,
    currency: 'BRL',
    provider: 'fake',
    attemptCount: 1,
    expiresAt: new Date(AGORA.getTime() + 15 * 60_000),
    lastProviderEventAt: null,
    createdAt: AGORA,
    updatedAt: AGORA,
    ...overrides,
  };
}

export function erroP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'teste',
  });
}

export interface PrismaFalso {
  idempotencyRecord: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  payment: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  paymentTransaction: { create: jest.Mock; update: jest.Mock };
  outboxEvent: { create: jest.Mock };
  $transaction: jest.Mock;
}

/**
 * Duble do PrismaClient.
 *
 * LIMITE IMPORTANTE: o $transaction daqui EXECUTA o callback mas NAO faz
 * rollback. Estes testes provam ORDEM DAS OPERACOES e DECISOES do servico, nao
 * atomicidade. Atomicidade so se prova com banco real — Bloco 8.
 *
 * O tratamento de `increment` existe porque persistirTentativa usa
 * `{ attemptCount: { increment: 1 } }`, e sem interpretar isso o duble
 * devolveria um objeto no lugar de um numero.
 */
export function prismaFalso(): PrismaFalso {
  const falso: PrismaFalso = {
    idempotencyRecord: {
      create: jest.fn(async () => ({ id: 'rec_1' })),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({ id: 'rec_1' })),
      delete: jest.fn(async () => ({ id: 'rec_1' })),
    },
    payment: {
      findUnique: jest.fn(async () => null),
      // Representa a linha DEPOIS do compare-and-swap: status PROCESSING e
      // contador incrementado. Explicito em vez de deduzido do findUnique — o
      // duble nao deve conter logica de banco, ou o teste passa a medir o duble.
      findUniqueOrThrow: jest.fn(async () =>
        paymentDeTeste({ status: PaymentStatus.PROCESSING, attemptCount: 2 }),
      ),
      // count 1 = o CAS venceu. Testes de perda sobrescrevem para { count: 0 }.
      // A semantica REAL de concorrencia so o Postgres prova (integracao).
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async (args: { data: Partial<Payment> }) =>
        paymentDeTeste(args.data),
      ),
      update: jest.fn(
        async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const base = paymentDeTeste({ id: args.where.id });
          const patch: Record<string, unknown> = {};
          for (const [campo, valor] of Object.entries(args.data)) {
            if (valor !== null && typeof valor === 'object' && 'increment' in valor) {
              const atual = (base as unknown as Record<string, number>)[campo];
              patch[campo] = atual + (valor as { increment: number }).increment;
            } else {
              patch[campo] = valor;
            }
          }
          return paymentDeTeste({ id: args.where.id, ...patch });
        },
      ),
    },
    paymentTransaction: {
      create: jest.fn(async () => ({ id: 'tx_1' })),
      update: jest.fn(async () => ({ id: 'tx_1' })),
    },
    // Sob captura automatica, registrarDesfecho tambem enfileira o evento na
    // MESMA transacao. Como o $transaction daqui entrega o proprio duble como
    // tx, este create serve aos dois lados.
    outboxEvent: { create: jest.fn(async () => ({ id: 'out_1' })) },
    $transaction: jest.fn(),
  };

  falso.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaFalso) => Promise<unknown>)(falso);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  return falso;
}

export function comoPrisma(falso: PrismaFalso): PrismaClient {
  return falso as unknown as PrismaClient;
}

export function orderClientFalso(buscarPedido: jest.Mock): OrderClient {
  return { buscarPedido } as unknown as OrderClient;
}

/** A chave foi marcada FAILED? Ignora o update que so vincula o paymentId. */
export function chaveMarcadaFalhada(falso: PrismaFalso): boolean {
  return falso.idempotencyRecord.update.mock.calls.some(
    ([arg]) => (arg as { data?: { status?: string } })?.data?.status === 'FAILED',
  );
}
