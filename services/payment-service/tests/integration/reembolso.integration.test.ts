import { randomUUID } from 'node:crypto';
import { PaymentStatus, TransactionStatus, TransactionType, type PrismaClient } from '@prisma/client';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { PaymentDomainError } from '../../src/domain/errors';
import { FakeProvider } from '../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../src/providers/fake/fake.tokens';
import type { PaymentProvider } from '../../src/providers/payment-provider.port';
import { PaymentService } from '../../src/services/payment.service';
import { assertTestDatabase } from '../helpers/testDbGuard';
import { SEGREDO_WEBHOOK } from '../helpers/config';
import { orderClientFalso, pedidoDeTeste } from '../helpers/prisma-fake';

/**
 * Reembolso INICIADO por nos (Bloco 7).
 *
 * O invariante e `soma dos reembolsos <= capturado`, com DUAS barreiras: o
 * provedor (serializa o DINHEIRO) e o nosso CAS (serializa a CONTABILIDADE).
 * A terceira defesa e a idempotencia: sem ela, um retry de rede vira reembolso
 * duplo.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  assertTestDatabase(process.env);
  prisma = await connectDatabase(process.env.DATABASE_URL as string);
});

afterEach(async () => {
  await prisma.outboxEvent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.payment.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});

function cenario(token: string, provider?: PaymentProvider) {
  const userId = randomUUID();
  const orderId = randomUUID();
  const pedido = pedidoDeTeste({ id: orderId, userId });

  const service = new PaymentService({
    prisma,
    orderClient: orderClientFalso(jest.fn(async () => pedido)),
    provider: provider ?? new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK }),
    currency: 'BRL',
    windowMinutes: 15,
  });

  return {
    service,
    userId,
    orderId,
    input: {
      userId,
      authorization: 'Bearer token.do.usuario',
      orderId,
      paymentMethodToken: token,
      idempotencyKey: randomUUID(),
    },
  };
}

/** Pagamento CAPTURED de verdade: captura automatica pelo caminho normal. */
async function pagamentoCapturado() {
  const ctx = cenario(FAKE_TOKENS.SUCCESS);
  await ctx.service.criarPagamento(ctx.input);

  const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
  expect(payment.status).toBe(PaymentStatus.CAPTURED);
  expect(payment.capturedAmountCents).toBeGreaterThan(0);
  expect(payment.refundedAmountCents).toBe(0);

  return { ...ctx, payment };
}

function pedidoDeReembolso(userId: string, paymentId: string, valorCents: number) {
  return { userId, idempotencyKey: randomUUID(), paymentId, valorCents };
}

async function linhasDeReembolso(paymentId: string) {
  return prisma.paymentTransaction.findMany({
    where: { paymentId, type: TransactionType.REFUND },
    orderBy: { createdAt: 'asc' },
  });
}

describe('reembolsar', () => {
  it('CASO R1: reembolso PARCIAL move o total e registra a movimentacao', async () => {
    const { service, userId, payment } = await pagamentoCapturado();
    const metade = Math.floor(payment.capturedAmountCents / 2);

    const r = await service.reembolsar(pedidoDeReembolso(userId, payment.id, metade));
    expect(r).toMatchObject({ tipo: 'aplicado', totalReembolsadoCents: metade });

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(metade);
    // O status NAO muda: reembolso e atributo do VALOR, nao transicao.
    expect(atual.status).toBe(PaymentStatus.CAPTURED);

    const linhas = await linhasDeReembolso(payment.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe(TransactionStatus.SUCCEEDED);
    // A trilha registra ESTA movimentacao; somar as linhas tem de dar o total.
    expect(linhas[0].amountCents).toBe(metade);
  });

  it('CASO R2: reembolsos parciais SEQUENCIAIS somam ate o capturado', async () => {
    const { service, userId, payment } = await pagamentoCapturado();
    const parte = Math.floor(payment.capturedAmountCents / 3);

    await service.reembolsar(pedidoDeReembolso(userId, payment.id, parte));
    await service.reembolsar(pedidoDeReembolso(userId, payment.id, parte));

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(parte * 2);
    expect((await linhasDeReembolso(payment.id)).map((x) => x.amountCents)).toEqual([parte, parte]);
  });

  it('CASO R3: valor acima do disponivel e recusado ANTES de mover dinheiro', async () => {
    const { service, userId, payment } = await pagamentoCapturado();

    const r = await service.reembolsar(
      pedidoDeReembolso(userId, payment.id, payment.capturedAmountCents + 1),
    );

    expect(r).toMatchObject({ tipo: 'excede-o-capturado' });
    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  it('CASO R4: pagamento que NAO esta CAPTURED nao pode ser reembolsado', async () => {
    const { service, userId, payment } = await pagamentoCapturado();
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.FAILED },
    });

    expect(await service.reembolsar(pedidoDeReembolso(userId, payment.id, 100))).toMatchObject({
      tipo: 'estado-invalido',
    });
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  it.each([0, -1, 1.5])('CASO R5: valor %p e recusado sem tocar em nada', async (valor) => {
    const { service, userId, payment } = await pagamentoCapturado();

    expect(await service.reembolsar(pedidoDeReembolso(userId, payment.id, valor))).toEqual({
      tipo: 'valor-invalido',
    });
    expect(await linhasDeReembolso(payment.id)).toHaveLength(0);
  });

  it('CASO R6: dois reembolsos CONCORRENTES nunca estouram o capturado', async () => {
    // O caso central do bloco. Cada um pede 60% do capturado: somados excedem.
    // Os dois passam na pre-checagem (leem refunded = 0) e so o PROVEDOR, que e
    // o ponto de serializacao do dinheiro, separa os dois.
    const { service, userId, payment } = await pagamentoCapturado();
    const parte = Math.ceil(payment.capturedAmountCents * 0.6);

    const [a, b] = await Promise.all([
      service.reembolsar(pedidoDeReembolso(userId, payment.id, parte)),
      service.reembolsar(pedidoDeReembolso(userId, payment.id, parte)),
    ]);

    expect([a.tipo, b.tipo].sort()).toEqual(['aplicado', 'excede-o-capturado']);

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(parte);
    expect(atual.refundedAmountCents).toBeLessThanOrEqual(atual.capturedAmountCents);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(1);
  });

  it('CASO R7: aceite ASSINCRONO nao move o total — quem confirma e o webhook', async () => {
    const { payment } = await pagamentoCapturado();
    const provider = {
      refund: jest.fn(async () => ({
        providerRefundRef: 're_pendente',
        state: 'PROCESSING' as const,
        amountCents: 100,
      })),
    } as unknown as PaymentProvider;
    const ctx = cenario(FAKE_TOKENS.SUCCESS, provider);

    const r = await ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, 100));

    expect(r).toMatchObject({ tipo: 'pendente' });
    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(0);

    const linhas = await linhasDeReembolso(payment.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe(TransactionStatus.PENDING);
  });

  it('CASO R8: recusa do provedor registra a tentativa e nao move o total', async () => {
    const { payment } = await pagamentoCapturado();
    const provider = {
      refund: jest.fn(async () => ({
        providerRefundRef: 're_recusado',
        state: 'DECLINED' as const,
        amountCents: 100,
        declineCode: 'refund_window_closed',
      })),
    } as unknown as PaymentProvider;
    const ctx = cenario(FAKE_TOKENS.SUCCESS, provider);

    const r = await ctx.service.reembolsar(pedidoDeReembolso(ctx.userId, payment.id, 100));

    expect(r).toMatchObject({ tipo: 'recusado', declineCode: 'refund_window_closed' });
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmountCents,
    ).toBe(0);

    const linhas = await linhasDeReembolso(payment.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe(TransactionStatus.FAILED);
    expect(linhas[0].failureCode).toBe('refund_window_closed');
  });

  it('CASO R9: a MESMA chave devolve a resposta congelada, sem segundo reembolso', async () => {
    // Sem isto, um retry de rede vira reembolso duplo — o pior desfecho possivel
    // desta operacao.
    const { service, userId, payment } = await pagamentoCapturado();
    const metade = Math.floor(payment.capturedAmountCents / 2);
    const pedido = pedidoDeReembolso(userId, payment.id, metade);

    const primeira = await service.reembolsar(pedido);
    const segunda = await service.reembolsar(pedido);

    expect(segunda).toEqual(primeira);

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(metade);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(1);
  });

  it('CASO R10: mesma chave com OUTRO valor e conflito, nao replay', async () => {
    // Mesmo achado 4.4 que o 6a corrigiu para o orderId: sem o valor no
    // fingerprint, reusar a chave pedindo outro montante devolveria em silencio
    // o reembolso anterior, e o operador acharia que reembolsou o novo valor.
    const { service, userId, payment } = await pagamentoCapturado();
    const pedido = pedidoDeReembolso(userId, payment.id, 100);

    await service.reembolsar(pedido);

    await expect(service.reembolsar({ ...pedido, valorCents: 200 })).rejects.toBeInstanceOf(
      PaymentDomainError,
    );

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.refundedAmountCents).toBe(100);
    expect(await linhasDeReembolso(payment.id)).toHaveLength(1);
  });
});
