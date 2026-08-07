import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../src/config/database';
import { MAX_AMOUNT_CENTS } from '../../src/domain/money';

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

function webhookValido(
  overrides: Partial<Prisma.WebhookEventCreateInput> = {},
): Prisma.WebhookEventCreateInput {
  return {
    provider: 'fake',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    payload: { ok: true },
    ...overrides,
  };
}

function outboxValido(
  overrides: Partial<Prisma.OutboxEventCreateInput> = {},
): Prisma.OutboxEventCreateInput {
  return {
    eventId: randomUUID(),
    routingKey: 'payment.succeeded',
    payload: { ok: true },
    ...overrides,
  };
}

afterEach(async () => {
  // Ordem ditada pelas FKs com Restrict: dependentes antes de payments.
  await prisma.idempotencyRecord.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.outboxEvent.deleteMany();
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

  it('aceita os limites inclusivos das invariantes', async () => {
    const criado = await prisma.payment.create({
      data: pagamentoValido({
        amountCents: 1000,
        capturedAmountCents: 1000, // captured == amount
        refundedAmountCents: 1000, // refunded == captured
      }),
    });

    expect(criado.refundedAmountCents).toBe(1000);
  });
});

describe('payment_amount_positivo', () => {
  it.each([0, -1])('recusa amountCents %i', async (valor) => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ amountCents: valor }) }),
    );
    expect(erro.message).toContain('payment_amount_positivo');
  });
});

describe('payment_captured_dentro_do_total', () => {
  it('recusa captured acima do total (lado superior do AND)', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({
        data: pagamentoValido({ amountCents: 1000, capturedAmountCents: 1001 }),
      }),
    );
    expect(erro.message).toContain('payment_captured_dentro_do_total');
  });

  it('recusa captured negativo (lado inferior do AND)', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ capturedAmountCents: -1 }) }),
    );
    expect(erro.message).toContain('payment_captured_dentro_do_total');
  });
});

describe('payment_refunded_dentro_do_capturado', () => {
  it('recusa refunded acima do capturado (lado superior do AND)', async () => {
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

  it('recusa refunded negativo (lado inferior do AND)', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ refundedAmountCents: -1 }) }),
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
});

describe('payment_attempt_count_nao_negativo', () => {
  it('recusa attemptCount negativo', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ attemptCount: -1 }) }),
    );
    expect(erro.message).toContain('payment_attempt_count_nao_negativo');
  });
});

describe('payment_currency_suportada', () => {
  it.each(['BR', 'USD', 'abc', '123', '   '])(
    'recusa a moeda nao suportada "%s"',
    async (moeda) => {
      const erro = await capturarViolacao(() =>
        prisma.payment.create({ data: pagamentoValido({ currency: moeda }) }),
      );
      expect(erro.message).toContain('payment_currency_suportada');
    },
  );
});

describe('teto monetario — amarra o dominio TS ao banco', () => {
  it('aceita exatamente MAX_AMOUNT_CENTS (limite inclusivo)', async () => {
    const criado = await prisma.payment.create({
      data: pagamentoValido({ amountCents: MAX_AMOUNT_CENTS }),
    });
    expect(criado.amountCents).toBe(MAX_AMOUNT_CENTS);
  });

  it('recusa MAX_AMOUNT_CENTS + 1 no pagamento', async () => {
    const erro = await capturarViolacao(() =>
      prisma.payment.create({ data: pagamentoValido({ amountCents: MAX_AMOUNT_CENTS + 1 }) }),
    );
    expect(erro.message).toContain('payment_amount_dentro_do_teto');
  });

  it('recusa MAX_AMOUNT_CENTS + 1 na transacao', async () => {
    const pagamento = await prisma.payment.create({ data: pagamentoValido() });

    const erro = await capturarViolacao(() =>
      prisma.paymentTransaction.create({
        data: {
          payment: { connect: { id: pagamento.id } },
          type: 'AUTHORIZE',
          amountCents: MAX_AMOUNT_CENTS + 1,
        },
      }),
    );
    expect(erro.message).toContain('transaction_amount_dentro_do_teto');
  });
});

describe('transaction_amount_positivo', () => {
  it.each([0, -1])('recusa transacao com amountCents %i', async (valor) => {
    const pagamento = await prisma.payment.create({ data: pagamentoValido() });

    const erro = await capturarViolacao(() =>
      prisma.paymentTransaction.create({
        data: {
          payment: { connect: { id: pagamento.id } },
          type: 'AUTHORIZE',
          amountCents: valor,
        },
      }),
    );
    expect(erro.message).toContain('transaction_amount_positivo');
  });
});

describe('webhook_events (inbox)', () => {
  it('persiste um evento valido', async () => {
    const criado = await prisma.webhookEvent.create({ data: webhookValido() });
    expect(criado.status).toBe('RECEIVED');
    expect(criado.attempts).toBe(0);
    expect(criado.providerCreatedAt).toBeNull();
  });

  it('recusa attempts negativo', async () => {
    const erro = await capturarViolacao(() =>
      prisma.webhookEvent.create({ data: webhookValido({ attempts: -1 }) }),
    );
    expect(erro.message).toContain('webhook_attempts_nao_negativo');
  });

  it('DEDUPLICA: recusa o mesmo evento do mesmo provedor duas vezes', async () => {
    const providerEventId = randomUUID();
    await prisma.webhookEvent.create({ data: webhookValido({ providerEventId }) });

    const erro = await capturarViolacao(() =>
      prisma.webhookEvent.create({ data: webhookValido({ providerEventId }) }),
    );
    expect(erro.message).toMatch(/provider|unique/i);
  });

  it('permite o mesmo eventId vindo de provedores diferentes', async () => {
    const providerEventId = randomUUID();
    await prisma.webhookEvent.create({ data: webhookValido({ provider: 'fake', providerEventId }) });

    const outro = await prisma.webhookEvent.create({
      data: webhookValido({ provider: 'stripe', providerEventId }),
    });
    expect(outro.provider).toBe('stripe');
  });
});

describe('outbox_events', () => {
  it('persiste um evento valido com status PENDING', async () => {
    const criado = await prisma.outboxEvent.create({ data: outboxValido() });
    expect(criado.status).toBe('PENDING');
    expect(criado.sentAt).toBeNull();
  });

  it('recusa attempts negativo', async () => {
    const erro = await capturarViolacao(() =>
      prisma.outboxEvent.create({ data: outboxValido({ attempts: -1 }) }),
    );
    expect(erro.message).toContain('outbox_attempts_nao_negativo');
  });

  it('recusa eventId duplicado', async () => {
    const eventId = randomUUID();
    await prisma.outboxEvent.create({ data: outboxValido({ eventId }) });

    const erro = await capturarViolacao(() =>
      prisma.outboxEvent.create({ data: outboxValido({ eventId }) }),
    );
    expect(erro.message).toMatch(/eventId|unique/i);
  });
});

describe('idempotency_records', () => {
  it('CLAIM-FIRST: aceita reserva de chave sem pagamento associado', async () => {
    const criado = await prisma.idempotencyRecord.create({
      data: { userId: randomUUID(), key: randomUUID() },
    });

    expect(criado.paymentId).toBeNull();
    expect(criado.status).toBe('PROCESSING');
  });

  it('recusa a mesma chave para o mesmo usuario', async () => {
    const userId = randomUUID();
    const key = randomUUID();
    await prisma.idempotencyRecord.create({ data: { userId, key } });

    const erro = await capturarViolacao(() =>
      prisma.idempotencyRecord.create({ data: { userId, key } }),
    );
    expect(erro.message).toMatch(/userId|key|unique/i);
  });

  it('permite a mesma chave para usuarios diferentes', async () => {
    const key = randomUUID();
    await prisma.idempotencyRecord.create({ data: { userId: randomUUID(), key } });

    const outro = await prisma.idempotencyRecord.create({
      data: { userId: randomUUID(), key },
    });
    expect(outro.key).toBe(key);
  });

  it('recusa paymentId que nao existe (integridade referencial)', async () => {
    const erro = await capturarViolacao(() =>
      prisma.idempotencyRecord.create({
        data: { userId: randomUUID(), key: randomUUID(), paymentId: randomUUID() },
      }),
    );
    expect(erro).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((erro as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
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

  it('recusa apagar pagamento com trilha de transacoes, pela FK Restrict', async () => {
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

    // Asercao forte: prova que foi a FK, e nao um erro qualquer.
    expect(erro).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((erro as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
    expect(erro.message).toContain('payment_transactions_paymentId_fkey');
  });

  it('recusa apagar pagamento referenciado por registro de idempotencia', async () => {
    const pagamento = await prisma.payment.create({ data: pagamentoValido() });
    await prisma.idempotencyRecord.create({
      data: { userId: randomUUID(), key: randomUUID(), paymentId: pagamento.id },
    });

    const erro = await capturarViolacao(() =>
      prisma.payment.delete({ where: { id: pagamento.id } }),
    );
    expect((erro as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
  });
});
