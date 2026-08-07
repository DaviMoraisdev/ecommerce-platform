import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../src/config/database';

/**
 * Executa uma escrita que DEVE ser recusada pelo banco e devolve o erro.
 * Se a escrita for aceita, falha com mensagem explicita — o pior resultado
 * possivel nao e o teste quebrar, e a constraint nao existir e ninguem notar.
 */
async function capturarViolacao(escrita: () => Promise<unknown>): Promise<Error> {
  try {
    await escrita();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Esperava violacao de constraint, mas a escrita foi ACEITA');
}

function pagamentoValido(
  overrides: Partial<Prisma.PaymentCreateInput> = {},
): Prisma.PaymentCreateInput {
  return {
    orderId: randomUUID(),
    userId: randomUUID(),
    amountCents: 12990,
    currency: 'BRL',
    provider: 'fake',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    ...overrides,
  };
}

afterEach(async () => {
  // Transacoes primeiro: onDelete e Restrict, apagar pagamento antes falha.
  await prisma.paymentTransaction.deleteMany();
  await prisma.payment.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('caminho feliz', () => {
  it('persiste um pagamento valido com defaults corretos', async () => {
    const criado = await prisma.payment.create({ data: pagamentoValido() });

    expect(criado.status).toBe('PENDING');
    expect(criado.amountCents).toBe(12990);
    expect(criado.capturedAmountCents).toBe(0);
    expect(criado.refundedAmountCents).toBe(0);
    expect(criado.attemptCount).toBe(0);
  });
});

describe('invariantes monetarias (CHECK constraints)', () => {
  it('recusa amountCents zero ou negativo', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ amountCents: 0 }) }),
    );
    expect(erro.message).toContain('payment_amount_positivo');
  });

  it('recusa capturar mais do que o valor do pagamento', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({
        data: pagamentoValido({ amountCents: 1000, capturedAmountCents: 1001 }),
      }),
    );
    expect(erro.message).toContain('payment_captured_dentro_do_total');
  });

  it('recusa reembolsar mais do que o valor capturado', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({
        data: pagamentoValido({
          amountCents: 1000,
          capturedAmountCents: 500,
          refundedAmountCents: 501,
        }),
      }),
    );
    expect(erro.message).toContain('payment_refunded_dentro_do_capturado');
  });

  it('recusa reembolso sobre pagamento nao capturado', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({
        data: pagamentoValido({ capturedAmountCents: 0, refundedAmountCents: 1 }),
      }),
    );
    expect(erro.message).toContain('payment_refunded_dentro_do_capturado');
  });

  it('recusa attemptCount negativo', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ attemptCount: -1 }) }),
    );
    expect(erro.message).toContain('payment_attempt_count_nao_negativo');
  });

  it('recusa moeda fora do formato ISO de 3 letras', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ currency: 'BR' }) }),
    );
    expect(erro.message).toContain('payment_currency_iso4217');
  });

  it('recusa transacao com valor zero ou negativo', async () => {
    const pagamento = await prisma.payment.create({ data: pagamentoValido() });

    const erro = await capturarViolacao(() =>
      prisma.paymentTransaction.create({
        data: {
          payment: { connect: { id: pagamento.id } },
          type: 'AUTHORIZE',
          amountCents: 0,
        },
      }),
    );
    expect(erro.message).toContain('transaction_amount_positivo');
  });
});

describe('regras estruturais', () => {
  it('recusa um segundo pagamento para o mesmo pedido', async () => {
    const orderId = randomUUID();
    await prisma.payment.create({ data: pagamentoValido({ orderId }) });

    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ orderId }) }),
    );
    expect(erro.message).toMatch(/orderId|unique/i);
  });

  it('recusa apagar pagamento que possui trilha de transacoes (Restrict)', async () => {
    const pagamento = await prisma.payment.create({ data: pagamentoValido() });
    await prisma.paymentTransaction.create({
      data: {
        payment: { connect: { id: pagamento.id } },
        type: 'AUTHORIZE',
        amountCents: 12990,
      },
    });

    const erro = await capturarViolacao(() =>
      prisma.payment.delete({ where: { id: pagamento.id } }),
    );
    expect(erro).toBeInstanceOf(Error);
  });
});
