import { randomUUID } from 'node:crypto';
import { PaymentStatus, TransactionStatus, TransactionType, type PrismaClient } from '@prisma/client';

import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { FakeProvider } from '../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../src/providers/fake/fake.tokens';
import { PaymentService } from '../../src/services/payment.service';
import { assertTestDatabase } from '../helpers/testDbGuard';
import { SEGREDO_WEBHOOK } from '../helpers/config';
import { orderClientFalso, pedidoDeTeste } from '../helpers/prisma-fake';
import * as outboxRepo from '../../src/events/outbox.repository';

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
  await prisma.outboxEvent.deleteMany();
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
    //
    // retryable TRUE apos o achado 4.5: nada financeiro aconteceu, entao a claim
    // e liberada e repetir a MESMA chave funciona.
    expect((falhas[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'TENTATIVA_EM_ANDAMENTO',
      retryable: true,
    });

    // Prova de que a claim foi liberada e nao queimada: sobrou apenas o registro
    // da vencedora. Se a perdedora tivesse sido marcada FAILED, seriam dois.
    expect(await prisma.idempotencyRecord.count()).toBe(1);
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
  // O nome anterior deste teste era 'permite nova chave' e ele NUNCA tentava uma
  // nova chave — prometia mais do que verificava. Levantado no segundo review do
  // PR #52, e foi por essa lacuna que a regressao do 4.1 passou.
  it('marca transacao, chave E PAGAMENTO como FAILED', async () => {
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

    // O CAS moveu o Payment para PROCESSING antes de chamar o provedor. Numa
    // falha DETERMINISTICA — o provedor recusou a requisicao sem tocar em
    // dinheiro — ele tem de voltar para FAILED, senao o pedido fica travado.
    expect(payment.status).toBe(PaymentStatus.FAILED);
  });

  it('permite de fato uma nova tentativa completa depois da falha deterministica', async () => {
    const { service, input, orderId, userId } = cenario(FAKE_TOKENS.ERROR_INVALID);

    await expect(service.criarPagamento(input)).rejects.toMatchObject({
      code: 'REQUISICAO_INVALIDA',
    });

    // A prova que faltava: cobrar de verdade com chave e token novos.
    const servicoQueFunciona = new PaymentService({
      prisma,
      orderClient: orderClientFalso(
        jest.fn(async () => pedidoDeTeste({ id: orderId, userId })),
      ),
      provider: new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK }),
      currency: 'BRL',
      windowMinutes: 15,
    });

    const segunda = await servicoQueFunciona.criarPagamento({
      ...input,
      idempotencyKey: randomUUID(),
      paymentMethodToken: FAKE_TOKENS.SUCCESS,
    });

    expect(segunda.status).toBe(PaymentStatus.CAPTURED);
    expect(segunda.attemptCount).toBe(2);
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
  });

  it('tambem devolve o pagamento a FAILED quando a credencial do provedor e invalida', async () => {
    const { service, input, orderId } = cenario(FAKE_TOKENS.ERROR_AUTHENTICATION);

    await expect(service.criarPagamento(input)).rejects.toMatchObject({
      code: 'DEPENDENCIA_INDISPONIVEL',
    });

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).toBe(PaymentStatus.FAILED);
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

describe('review 4.1 — retentativas concorrentes sobre Payment existente', () => {
  it('duas chaves diferentes sobre Payment PENDING produzem UMA cobranca', async () => {
    const { service, espiaoCharge, input, userId, orderId } = cenario();

    // Semeia o estado que a corrida exige: Payment ja existente em PENDING,
    // dentro da janela. E o estado deixado por uma tentativa que sofreu falha
    // transiente — nada no head atual move o Payment para PROCESSING antes de
    // chamar o provedor.
    await prisma.payment.create({
      data: {
        orderId,
        userId,
        amountCents: 12990,
        currency: 'BRL',
        provider: 'fake',
        attemptCount: 1,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });

    const resultados = await Promise.allSettled([
      service.criarPagamento({ ...input, idempotencyKey: randomUUID() }),
      service.criarPagamento({ ...input, idempotencyKey: randomUUID() }),
    ]);

    const chaves = espiaoCharge.mock.calls.map((c) => c[0].idempotencyKey);

    // REGRESSAO do achado 4.1. Antes do compare-and-swap, ambas passavam por
    // assertNovaTentativaPermitida (PENDING era aceito), incrementavam para 2 e
    // 3, e o provedor recebia DUAS chaves distintas: duas cobrancas para o mesmo
    // pedido. Medido na epoca como ["<id>:2", "<id>:3"].
    expect(chaves).toHaveLength(1);
    expect(espiaoCharge).toHaveBeenCalledTimes(1);

    const perdedoras = resultados.filter((r) => r.status === 'rejected');
    expect(perdedoras).toHaveLength(1);
    expect((perdedoras[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'TENTATIVA_EM_ANDAMENTO',
    });
  });

  it('falha transiente deixa o Payment em estado que BLOQUEIA nova tentativa', async () => {
    const { service, input } = cenario(FAKE_TOKENS.ERROR_UNAVAILABLE);

    await expect(service.criarPagamento(input)).rejects.toMatchObject({
      code: 'DEPENDENCIA_INDISPONIVEL',
    });

    // REGRESSAO do achado 4.1. Com o Payment preso em PROCESSING, uma chave
    // NOVA nao pode abrir segunda cobranca enquanto a primeira esta ambigua.
    // Antes da correcao o Payment ficava PENDING e a nova tentativa passava.
    await expect(
      service.criarPagamento({ ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'TENTATIVA_EM_ANDAMENTO' });
  });
});

describe('review 4.4 — a chave fica vinculada a requisicao que a criou', () => {
  it('recusa a MESMA chave aplicada a outro pedido, sem cobrar', async () => {
    const { service, espiaoCharge, input, userId } = cenario();

    await service.criarPagamento(input);

    const outroPedido = randomUUID();
    const servicoDoOutroPedido = new PaymentService({
      prisma,
      orderClient: orderClientFalso(
        jest.fn(async () => pedidoDeTeste({ id: outroPedido, userId })),
      ),
      provider: new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK }),
      currency: 'BRL',
      windowMinutes: 15,
    });

    // MESMA Idempotency-Key, pedido DIFERENTE. Antes do achado 4.4 isto
    // devolvia 200 com o pagamento do primeiro pedido.
    await expect(
      servicoDoOutroPedido.criarPagamento({ ...input, orderId: outroPedido }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCIA_CONFLITANTE' });

    expect(espiaoCharge).toHaveBeenCalledTimes(1);
    expect(await prisma.payment.count({ where: { orderId: outroPedido } })).toBe(0);
  });
});

describe('captura SINCRONA tambem emite o evento', () => {
  it('CASO F1: createCharge SUCCEEDED grava a outbox na mesma transacao', async () => {
    // Caminho PADRAO do projeto (captura automatica, decisao 10 da fase): o
    // registrarDesfecho leva o pagamento a CAPTURED na hora. Sem enqueue aqui,
    // nenhum evento e emitido — e um webhook posterior NAO conserta, porque o
    // WebhookService curto-circuita quando o estado alvo ja e o atual.
    const { service, input, orderId } = cenario();

    const resultado = await service.criarPagamento(input);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).toBe(PaymentStatus.CAPTURED);

    const eventos = await prisma.outboxEvent.findMany();
    expect(eventos).toHaveLength(1);
    expect(eventos[0].routingKey).toBe('payment.captured');
    expect(eventos[0].eventId).toBe(`payment.captured:${resultado.paymentId}`);

    const payload = eventos[0].payload as Record<string, unknown>;
    expect(payload.paymentId).toBe(resultado.paymentId);
    expect(payload.orderId).toBe(orderId);
    expect(payload.capturedAmountCents).toBe(payment.capturedAmountCents);
  });

  it('CASO F2: falha ao gravar o evento desfaz o desfecho INTEIRO', async () => {
    // O CASO 30 ocupa o eventId de proposito, mas ali o payment ja existe. Aqui
    // o id nasce dentro do create, entao a colisao real e inalcancavel: a falha
    // e injetada no enqueue. O gatilho e simulado, o rollback NAO — quem desfaz
    // e o Postgres. Se o enqueue estivesse FORA da transacao do desfecho, a
    // captura commitaria e este teste pegaria.
    // Criacao e desfecho sao transacoes separadas: o pagamento ja commitou como
    // PROCESSING antes, entao o esperado e ele continuar PROCESSING.
    const { service, input, orderId } = cenario();
    const espiao = jest
      .spyOn(outboxRepo, 'enqueue')
      .mockRejectedValue(new Error('falha simulada na gravacao do evento'));

    // Sem assertiva sobre propagacao: o que esta sob teste e a atomicidade, nao
    // como o servico embrulha o erro.
    await service.criarPagamento(input).catch(() => undefined);
    espiao.mockRestore();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).toBe(PaymentStatus.PROCESSING);
    expect(payment.capturedAmountCents).toBe(0);

    const capturas = await prisma.paymentTransaction.findMany({
      where: { paymentId: payment.id, type: TransactionType.CAPTURE },
    });
    expect(capturas).toHaveLength(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });
});

describe('replay idempotente', () => {
  it('CASO F3: replay de chave RECUSADA nao pode devolver o sucesso de outra chave', async () => {
    // Achado 4.4 do review do PR #52, em forma executavel.
    //
    // O replay le o Payment VIVO e o failureCode da transacao MAIS RECENTE.
    // Como o orderId e unique, a segunda tentativa reusa a MESMA linha de
    // Payment — entao, depois que outra chave captura, a chave recusada passa a
    // responder CAPTURED. O sistema afirma sobre AQUELA tentativa um desfecho
    // que ela nunca teve.
    const { service, input } = cenario(FAKE_TOKENS.DECLINED_INSUFFICIENT_FUNDS);
    const chaveRecusada = input.idempotencyKey;

    const recusada = await service.criarPagamento(input);
    expect(recusada.status).toBe(PaymentStatus.FAILED);
    expect(recusada.declineCode).toBe('insufficient_funds');

    // Outra chave, mesmo pedido, agora com sucesso: reusa a linha de Payment
    // com attemptCount + 1.
    const sucesso = await service.criarPagamento({
      ...input,
      paymentMethodToken: FAKE_TOKENS.SUCCESS,
      idempotencyKey: randomUUID(),
    });
    expect(sucesso.status).toBe(PaymentStatus.CAPTURED);

    // O replay da PRIMEIRA chave tem de descrever a PRIMEIRA tentativa.
    const replay = await service.criarPagamento({ ...input, idempotencyKey: chaveRecusada });
    expect(replay.replay).toBe(true);
    expect(replay.status).toBe(PaymentStatus.FAILED);
    expect(replay.declineCode).toBe('insufficient_funds');
    expect(replay.attemptCount).toBe(recusada.attemptCount);
  });
});
