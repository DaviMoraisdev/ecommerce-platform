import { OrderStatus } from '@prisma/client';
import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';
import { aplicarCaptura } from '../src/services/payment-capture.service';
import { CapturaEvent } from '../src/events/payment-events';

/**
 * O que ESTE arquivo prova e o unitario NAO pode provar:
 *  - o @unique do inbox realmente aborta a transacao inteira;
 *  - os desfechos sem efeito realmente DESFAZEM o insert do inbox;
 *  - o unique parcial de pending_compensations realmente impede a segunda
 *    pendencia aberta.
 * O unitario de payments.consumer.test.ts prova a traducao em acao do broker;
 * aqui a questao e o que fica gravado.
 */

beforeAll(() => assertTestDatabase());

afterEach(async () => {
  await prisma.inboxEvent.deleteMany();
  await prisma.pendingCompensation.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.order.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function pedido(status: OrderStatus = OrderStatus.PENDENTE, total = 100) {
  return prisma.order.create({ data: { userId: 'u1', status, total } });
}

function evento(orderId: string, over: Partial<CapturaEvent> = {}): CapturaEvent {
  const paymentId = over.paymentId ?? 'pay_1';
  return {
    eventId: 'payment.captured:' + paymentId,
    paymentId,
    orderId,
    amountCents: 10000,
    capturedAmountCents: 10000,
    currency: 'BRL',
    occurredAt: '2026-08-22T12:00:00.000Z',
    ...over,
  };
}

describe('aplicarCaptura — efeito e marca no mesmo commit', () => {
  it('CASO G1: PENDENTE vira PAGO, com trilha, inbox e evento de saida', async () => {
    const o = await pedido();

    await expect(aplicarCaptura(evento(o.id))).resolves.toEqual({ tipo: 'aplicado' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.PAGO);

    const trilha = await prisma.orderStatusHistory.findMany({ where: { orderId: o.id } });
    expect(trilha).toHaveLength(1);
    expect(trilha[0].fromStatus).toBe(OrderStatus.PENDENTE);
    expect(trilha[0].toStatus).toBe(OrderStatus.PAGO);
    // Autoria NUNCA vem do payload: quem publica no exchange nao escolhe quem
    // assina a trilha de auditoria.
    expect(trilha[0].changedBy).toBe('payment-service');

    expect(await prisma.inboxEvent.count()).toBe(1);

    // A transicao emite order.status_changed na MESMA transacao: o notification
    // e avisado sem nenhum codigo novo.
    const saida = await prisma.outboxEvent.findMany();
    expect(saida).toHaveLength(1);
    expect(saida[0].routingKey).toBe('order.status_changed');
  });

  it('CASO G2: reentrega do MESMO evento nao aplica o efeito duas vezes', async () => {
    const o = await pedido();
    const ev = evento(o.id);

    await expect(aplicarCaptura(ev)).resolves.toEqual({ tipo: 'aplicado' });
    await expect(aplicarCaptura(ev)).resolves.toEqual({ tipo: 'duplicata' });

    expect(await prisma.inboxEvent.count()).toBe(1);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id } })).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('CASO G3: pedido ja PAGO por outro caminho e ack sem nova transicao', async () => {
    const o = await pedido(OrderStatus.PAGO);

    await expect(aplicarCaptura(evento(o.id))).resolves.toEqual({ tipo: 'ja-pago' });

    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id } })).toBe(0);
    // O evento FOI contabilizado, entao a marca fica.
    expect(await prisma.inboxEvent.count()).toBe(1);
  });

  it('CASO G4: pedido CANCELADO registra compensacao em vez de transicao', async () => {
    const o = await pedido(OrderStatus.CANCELADO);

    await expect(aplicarCaptura(evento(o.id))).resolves.toEqual({
      tipo: 'compensacao-registrada',
    });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.CANCELADO);

    const pend = await prisma.pendingCompensation.findMany({ where: { orderId: o.id } });
    expect(pend).toHaveLength(1);
    expect(pend[0].resolvedAt).toBeNull();
    expect(await prisma.inboxEvent.count()).toBe(1);
  });

  it('CASO G5: pedido inexistente NAO deixa marca no inbox', async () => {
    // O invariante do inbox: linha existe se e somente se o efeito aconteceu.
    // Commitar a marca de um evento que nao produziu efeito faria a redentrega
    // ser tratada como duplicata — o mesmo buraco do claim no Redis.
    await expect(aplicarCaptura(evento('00000000-0000-0000-0000-000000000000'))).resolves.toEqual(
      { tipo: 'pedido-inexistente' },
    );

    expect(await prisma.inboxEvent.count()).toBe(0);
  });

  it('CASO G6: valor divergente NAO deixa marca e NAO muda o pedido', async () => {
    const o = await pedido(OrderStatus.PENDENTE, 100);

    await expect(
      aplicarCaptura(evento(o.id, { capturedAmountCents: 9900 })),
    ).resolves.toEqual({ tipo: 'valor-divergente', esperadoCents: 10000, recebidoCents: 9900 });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.PENDENTE);
    expect(await prisma.inboxEvent.count()).toBe(0);
    expect(await prisma.orderStatusHistory.count()).toBe(0);
  });

  it('CASO G7: segunda captura do mesmo pedido cancelado nao duplica pendencia', async () => {
    const o = await pedido(OrderStatus.CANCELADO);

    await aplicarCaptura(evento(o.id, { paymentId: 'pay_1' }));
    await expect(aplicarCaptura(evento(o.id, { paymentId: 'pay_2' }))).resolves.toEqual({
      tipo: 'compensacao-registrada',
    });

    // O unique parcial permite UMA pendencia aberta por pedido.
    expect(await prisma.pendingCompensation.count({ where: { orderId: o.id } })).toBe(1);
    expect(await prisma.inboxEvent.count()).toBe(2);
  });

  it('CASO G8: pedido ENVIADO recebe captura tardia sem loop de requeue', async () => {
    // ENVIADO so e alcancavel passando por PAGO, entao o efeito ja aconteceu.
    // Deixar cair em aplicarTransicao lancaria TRANSICAO_INVALIDA -> requeue
    // eterno, porque ENVIADO -> PAGO nunca vira valido.
    const o = await pedido(OrderStatus.ENVIADO);

    await expect(aplicarCaptura(evento(o.id))).resolves.toEqual({ tipo: 'ja-pago' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.ENVIADO);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id } })).toBe(0);
  });
});
