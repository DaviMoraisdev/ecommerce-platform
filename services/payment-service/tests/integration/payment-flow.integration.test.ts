import { randomUUID } from 'node:crypto';
import { PaymentStatus, TransactionStatus, TransactionType, type PrismaClient } from '@prisma/client';

import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { FakeProvider } from '../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../src/providers/fake/fake.tokens';
import { PaymentService } from '../../src/services/payment.service';
import { assertTestDatabase } from '../helpers/testDbGuard';
import { SEGREDO_WEBHOOK } from '../helpers/config';
import { orderClientFalso, pedidoDeTeste } from '../helpers/prisma-fake';

/**
 * O que ESTE arquivo prova e os testes unitarios NAO podem provar.
 *
 * O duble de Prisma executa o callback do $transaction mas nao faz rollback, e
 * nao tem nenhum dos 11 CHECK nem as constraints de unicidade. Entao ele nao
 * pode falhar quando:
 *
 *   - a chave e marcada COMPLETED sem paymentId (CHECK
 *     idempotency_completed_exige_pagamento);
 *   - duas requisicoes concorrentes criam Payment para o mesmo orderId
 *     (orderId @unique);
 *   - uma transacao parcialmente escrita nao e desfeita.
 *
 * O order-service continua sendo duble: ele e outro deployable atras da rede, e
 * exercitar HTTP real e escopo do e2e do Bloco 8.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  // Defesa em profundidade: o setup.integration.ts ja rodou a guarda, mas aqui
  // ha deleteMany() e a config do Jest e sobrescrevivel por linha de comando.
  assertTestDatabase(process.env);
  prisma = await connectDatabase(process.env.DATABASE_URL as string);
});

afterEach(async () => {
  // Ordem ditada pelas FKs com Restrict: dependentes antes de payments.
  await prisma.idempotencyRecord.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.payment.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});

function cenario(token: string = FAKE_TOKENS.SUCCESS) {
  const userId = randomUUID();
  const orderId = randomUUID();
  const pedido = pedidoDeTeste({ id: orderId, userId });

  const provider = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
  const espiaoCharge = jest.spyOn(provider, 'createCharge');

  const service = new PaymentService({
    prisma,
    orderClient: orderClientFalso(jest.fn(async () => pedido)),
    provider,
    currency: 'BRL',
    windowMinutes: 15,
  });

  const input = {
    userId,
    authorization: 'Bearer token.do.usuario',
    orderId,
    paymentMethodToken: token,
    idempotencyKey: randomUUID(),
  };

  return { service, provider, espiaoCharge, input, userId, orderId };
}

describe('criarPagamento contra Postgres — caminho de sucesso', () => {
  it('persiste Payment CAPTURED, as duas transacoes e a chave COMPLETED com paymentId', async () => {
    const { service, input, orderId } = cenario();

    const resultado = await service.criarPagamento(input);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).toBe(PaymentStatus.CAPTURED);
    expect(payment.amountCents).toBe(12990);
    expect(payment.capturedAmountCents).toBe(12990);
    expect(payment.attemptCount).toBe(1);
    expect(resultado.paymentId).toBe(payment.id);

    const transacoes = await prisma.paymentTransaction.findMany({
      where: { paymentId: payment.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(transacoes).toHaveLength(2);
    expect(transacoes[0]).toMatchObject({
      type: TransactionType.AUTHORIZE,
      status: TransactionStatus.SUCCEEDED,
    });
    expect(transacoes[1]).toMatchObject({
      type: TransactionType.CAPTURE,
      status: TransactionStatus.SUCCEEDED,
      amountCents: 12990,
    });
    expect(transacoes[0].providerRef).not.toBeNull();

    // O CHECK idempotency_completed_exige_pagamento so aceita COMPLETED com
    // paymentId preenchido. Se o servico marcasse COMPLETED antes de vincular o
    // pagamento, o BANCO recusaria — e o duble jamais recusaria.
    const registro = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { key: input.idempotencyKey },
    });
    expect(registro.status).toBe('COMPLETED');
    expect(registro.paymentId).toBe(payment.id);
  });
});

describe('criarPagamento contra Postgres — idempotencia com constraint real', () => {
  it('repetir a MESMA chave nao cria segundo pagamento nem segunda cobranca', async () => {
    const { service, espiaoCharge, input, orderId } = cenario();

    const primeira = await service.criarPagamento(input);
    const segunda = await service.criarPagamento(input);

    expect(primeira.replay).toBe(false);
    expect(segunda.replay).toBe(true);
    expect(segunda.paymentId).toBe(primeira.paymentId);
    expect(espiaoCharge).toHaveBeenCalledTimes(1);
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
  });

  it('duas requisicoes CONCORRENTES com a mesma chave produzem UMA cobranca', async () => {
    const { service, espiaoCharge, input, orderId } = cenario();

    const [a, b] = await Promise.allSettled([
      service.criarPagamento(input),
      service.criarPagamento(input),
    ]);

    // Nao fixamos QUAL vence nem se a perdedora recebe replay ou
    // IDEMPOTENCIA_EM_ANDAMENTO: depende do entrelacamento. O invariante que
    // importa e monetario.
    expect(espiaoCharge).toHaveBeenCalledTimes(1);
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);

    const desfechos = [a, b].map((r) =>
      r.status === 'fulfilled' ? 'ok' : (r.reason as { code?: string }).code,
    );
    expect(desfechos).toContain('ok');
  });
});

describe('criarPagamento contra Postgres — concorrencia no mesmo pedido', () => {
  it('duas chaves DIFERENTES para o mesmo orderId nao criam dois pagamentos', async () => {
    const { service, espiaoCharge, input, orderId } = cenario();
    const outraChave = { ...input, idempotencyKey: randomUUID() };

    const resultados = await Promise.allSettled([
      service.criarPagamento(input),
      service.criarPagamento(outraChave),
    ]);

    // orderId e @unique no schema: o banco e a ultima linha de defesa contra
    // dois pagamentos para o mesmo pedido. Sem a constraint, duas requisicoes
    // com chaves distintas passariam pelas duas checagens de idempotencia.
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    expect(espiaoCharge).toHaveBeenCalledTimes(1);

    const falhas = resultados.filter((r) => r.status === 'rejected');
    expect(falhas).toHaveLength(1);

    // A perdedora recebia PrismaClientKnownRequestError CRU (P2002), que subia
    // sem traducao e virava 500 no controller. Medido neste teste antes da
    // correcao. Agora e erro de dominio, e o controller devolve 409.
    expect((falhas[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'TENTATIVA_EM_ANDAMENTO',
      retryable: false,
    });
  });
});

describe('criarPagamento contra Postgres — falha transiente deixa rastro recuperavel', () => {
  it('mantem a transacao PENDING sem providerRef e a chave em PROCESSING', async () => {
    const { service, input, orderId } = cenario(FAKE_TOKENS.ERROR_UNAVAILABLE);

    await expect(service.criarPagamento(input)).rejects.toMatchObject({
      code: 'DEPENDENCIA_INDISPONIVEL',
      retryable: true,
    });

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    const transacoes = await prisma.paymentTransaction.findMany({
      where: { paymentId: payment.id },
    });

    // ESTE e o contrato com o job do Bloco 6: transacao PENDING com providerRef
    // NULO e o rastro de "pode ter cobrado, resposta perdida". E o motivo pelo
    // qual providerRef e nullable no schema.
    expect(transacoes).toHaveLength(1);
    expect(transacoes[0].status).toBe(TransactionStatus.PENDING);
    expect(transacoes[0].providerRef).toBeNull();

    const registro = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { key: input.idempotencyKey },
    });
    // PROCESSING, nao FAILED: FAILED liberaria nova tentativa com attemptCount+1
    // e chave de provedor nova, resultando em SEGUNDA COBRANCA.
    expect(registro.status).toBe('PROCESSING');
  });

  it('repetir a mesma chave depois da falha transiente devolve erro retentavel, nao nova cobranca', async () => {
    const { service, espiaoCharge, input } = cenario(FAKE_TOKENS.ERROR_UNAVAILABLE);

    await expect(service.criarPagamento(input)).rejects.toMatchObject({
      code: 'DEPENDENCIA_INDISPONIVEL',
    });
    await expect(service.criarPagamento(input)).rejects.toMatchObject({
      code: 'IDEMPOTENCIA_EM_ANDAMENTO',
      retryable: true,
    });

    // A segunda chamada nem chegou ao provedor.
    expect(espiaoCharge).toHaveBeenCalledTimes(1);
  });
});

describe('criarPagamento contra Postgres — falha deterministica', () => {
  it('marca transacao e chave como FAILED e permite nova chave', async () => {
    const { service, input, orderId } = cenario(FAKE_TOKENS.ERROR_INVALID);

    await expect(service.criarPagamento(input)).rejects.toMatchObject({
      code: 'REQUISICAO_INVALIDA',
    });

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    const transacoes = await prisma.paymentTransaction.findMany({
      where: { paymentId: payment.id },
    });
    expect(transacoes[0].status).toBe(TransactionStatus.FAILED);

    const registro = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { key: input.idempotencyKey },
    });
    expect(registro.status).toBe('FAILED');
  });
});

describe('criarPagamento contra Postgres — retentativa na janela', () => {
  it('depois de recusa, nova chave cobra de novo com attemptCount incrementado', async () => {
    const { service, espiaoCharge, input, orderId } = cenario(
      FAKE_TOKENS.DECLINED_INSUFFICIENT_FUNDS,
    );

    const recusado = await service.criarPagamento(input);
    expect(recusado.status).toBe(PaymentStatus.FAILED);
    expect(recusado.declineCode).toBe('insufficient_funds');

    const segunda = await service.criarPagamento({
      ...input,
      idempotencyKey: randomUUID(),
      paymentMethodToken: FAKE_TOKENS.SUCCESS,
    });

    expect(segunda.status).toBe(PaymentStatus.CAPTURED);
    expect(segunda.attemptCount).toBe(2);
    expect(segunda.paymentId).toBe(recusado.paymentId);

    // Chave DERIVADA: a segunda tentativa usa paymentId:2, entao o provedor a
    // trata como cobranca nova. Com a nossa chave HTTP, ele devolveria a recusa
    // da primeira e o cliente nunca trocaria de cartao.
    const chaves = espiaoCharge.mock.calls.map((c) => c[0].idempotencyKey);
    expect(chaves).toEqual([`${recusado.paymentId}:1`, `${recusado.paymentId}:2`]);

    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
  });

  it('recusa nova tentativa quando o pedido ja foi pago', async () => {
    const { service, input } = cenario();

    await service.criarPagamento(input);

    await expect(
      service.criarPagamento({ ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'PEDIDO_JA_PAGO' });
  });
});
