import { randomUUID } from 'node:crypto';
import { PaymentStatus, TransactionStatus, TransactionType, type PrismaClient } from '@prisma/client';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { FakeProvider } from '../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../src/providers/fake/fake.tokens';
import { PaymentService } from '../../src/services/payment.service';
import { assertTestDatabase } from '../helpers/testDbGuard';
import { SEGREDO_WEBHOOK } from '../helpers/config';
import { orderClientFalso, pedidoDeTeste } from '../helpers/prisma-fake';
import { decidirReconciliacao } from '../../src/jobs/reconciliacao';
import { buscarTentativasPresas } from '../../src/jobs/reconciliacao.repository';

/**
 * O estado preso e montado de PONTA A PONTA, nao fabricado no banco: o token
 * TIMEOUT_AFTER_CHARGE cobra de verdade no fake e so entao falha, deixando a
 * tentativa PENDING sem providerRef e a chave em PROCESSING. Fabricar o estado
 * a mao provaria que o job funciona sobre linhas que EU escrevi, nao sobre as
 * que o servico produz.
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

function cenario(token: string) {
  const userId = randomUUID();
  const orderId = randomUUID();
  const pedido = pedidoDeTeste({ id: orderId, userId });
  const provider = new FakeProvider({ webhookSecret: SEGREDO_WEBHOOK });
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
  return { service, provider, input, orderId };
}

/** Reproduz o estado que o job encontra: cobrado no provedor, perdido para nos. */
async function tentativaPresa(token: string) {
  const ctx = cenario(token);
  await expect(ctx.service.criarPagamento(ctx.input)).rejects.toThrow();

  const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: ctx.orderId } });
  const tentativa = await prisma.paymentTransaction.findFirstOrThrow({
    where: { paymentId: payment.id, type: TransactionType.AUTHORIZE },
  });

  // Pre-condicoes do rastro, senao o resto do teste nao significa nada.
  expect(payment.status).toBe(PaymentStatus.PROCESSING);
  expect(tentativa.status).toBe(TransactionStatus.PENDING);
  expect(tentativa.providerRef).toBeNull();

  return { ...ctx, payment, tentativa };
}

describe('buscarTentativasPresas', () => {
  it('CASO J4: so devolve tentativas PENDING, sem providerRef e ANTES do limite', async () => {
    // Os casos S1-S7 injetam esta consulta como duble, entao o filtro real
    // nunca foi exercitado. Filtro errado aqui nao quebra nada visivelmente:
    // o job varre o vazio para sempre, ou pior, alcanca tentativas em voo.
    const { payment, tentativa } = await tentativaPresa(FAKE_TOKENS.TIMEOUT_AFTER_CHARGE);

    // Envelhece a tentativa para que ela caia dentro da janela.
    await prisma.paymentTransaction.update({
      where: { id: tentativa.id },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const limite = new Date(Date.now() - 15 * 60 * 1000);
    const encontradas = await buscarTentativasPresas(limite, 20);

    expect(encontradas.map((t) => t.id)).toContain(tentativa.id);
    expect(encontradas.find((t) => t.id === tentativa.id)?.attemptCount).toBe(
      payment.attemptCount,
    );
  });

  it('CASO J5: tentativa RECENTE nao e candidata', async () => {
    // A janela e correcao, nao otimizacao: sem ela o job alcancaria uma
    // tentativa cuja chamada ao provedor ainda esta em voo e aplicaria desfecho
    // por baixo da propria requisicao que a criou.
    const { tentativa } = await tentativaPresa(FAKE_TOKENS.TIMEOUT_AFTER_CHARGE);

    const limite = new Date(Date.now() - 15 * 60 * 1000);
    const encontradas = await buscarTentativasPresas(limite, 20);

    expect(encontradas.map((t) => t.id)).not.toContain(tentativa.id);
  });

  it('CASO J6: tentativa ja resolvida deixa de ser candidata', async () => {
    const { service, provider, payment, tentativa } = await tentativaPresa(
      FAKE_TOKENS.TIMEOUT_AFTER_CHARGE,
    );
    await prisma.paymentTransaction.update({
      where: { id: tentativa.id },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const snapshot = await provider.buscarCobrancaPorTentativa(payment.id, payment.attemptCount);
    const acao = decidirReconciliacao(snapshot);
    if (acao.tipo !== 'aplicar') throw new Error('esperado aplicar');
    await service.aplicarDesfechoDeReconciliacao(tentativa.id, acao.resultado);

    const limite = new Date(Date.now() - 15 * 60 * 1000);
    const encontradas = await buscarTentativasPresas(limite, 20);

    expect(encontradas.map((t) => t.id)).not.toContain(tentativa.id);
  });
});

describe('reconciliacao de tentativa presa', () => {
  it('CASO J1: cobranca EXISTE e sucedeu — aplica o desfecho completo', async () => {
    const { service, provider, payment, tentativa } = await tentativaPresa(
      FAKE_TOKENS.TIMEOUT_AFTER_CHARGE,
    );

    const snapshot = await provider.buscarCobrancaPorTentativa(payment.id, payment.attemptCount);
    const acao = decidirReconciliacao(snapshot);
    expect(acao.tipo).toBe('aplicar');
    if (acao.tipo !== 'aplicar') return;

    await expect(
      service.aplicarDesfechoDeReconciliacao(tentativa.id, acao.resultado),
    ).resolves.toBe(true);

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.status).toBe(PaymentStatus.CAPTURED);

    const trilha = await prisma.paymentTransaction.findMany({ where: { paymentId: payment.id } });
    expect(trilha.filter((t) => t.type === TransactionType.CAPTURE)).toHaveLength(1);
    expect(trilha.find((t) => t.id === tentativa.id)?.providerRef).not.toBeNull();

    const chave = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { paymentId: payment.id },
    });
    expect(chave.status).toBe('COMPLETED');
    expect(chave.completedResponse).not.toBeNull();

    // O pedido precisa saber: sem o evento, o order nunca vira PAGO.
    const eventos = await prisma.outboxEvent.findMany();
    expect(eventos).toHaveLength(1);
    expect(eventos[0].routingKey).toBe('payment.captured');
  });

  it('CASO J2: cobranca NAO existe — libera a tentativa para nova cobranca', async () => {
    // Token de erro comum: o fake NAO cria cobranca, entao o provedor responde
    // null. E a unica evidencia que autoriza destravar o cliente.
    const { service, provider, payment, tentativa } = await tentativaPresa(
      FAKE_TOKENS.ERROR_UNAVAILABLE,
    );

    const snapshot = await provider.buscarCobrancaPorTentativa(payment.id, payment.attemptCount);
    expect(snapshot).toBeNull();
    expect(decidirReconciliacao(snapshot)).toEqual({ tipo: 'liberar' });

    await expect(service.liberarTentativaPresa(tentativa.id)).resolves.toBe(true);

    const atual = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(atual.status).toBe(PaymentStatus.FAILED);

    const t = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: tentativa.id } });
    expect(t.status).toBe(TransactionStatus.FAILED);
    expect(t.failureCode).toBe('RECONCILIADO_SEM_COBRANCA');

    const chave = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { paymentId: payment.id },
    });
    expect(chave.status).toBe('FAILED');
  });

  it('CASO J3: duas execucoes do job aplicam UMA vez', async () => {
    // O compare-and-swap vive na MESMA transacao do desfecho. Fora dela haveria
    // janela entre reivindicar e aplicar — e aplicar duas vezes criaria duas
    // linhas de CAPTURE e dois eventos para a mesma captura.
    const { service, provider, payment, tentativa } = await tentativaPresa(
      FAKE_TOKENS.TIMEOUT_AFTER_CHARGE,
    );

    const snapshot = await provider.buscarCobrancaPorTentativa(payment.id, payment.attemptCount);
    const acao = decidirReconciliacao(snapshot);
    if (acao.tipo !== 'aplicar') throw new Error('esperado aplicar');

    const primeira = await service.aplicarDesfechoDeReconciliacao(tentativa.id, acao.resultado);
    const segunda = await service.aplicarDesfechoDeReconciliacao(tentativa.id, acao.resultado);

    expect(primeira).toBe(true);
    expect(segunda).toBe(false);

    const capturas = await prisma.paymentTransaction.findMany({
      where: { paymentId: payment.id, type: TransactionType.CAPTURE },
    });
    expect(capturas).toHaveLength(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });
});
