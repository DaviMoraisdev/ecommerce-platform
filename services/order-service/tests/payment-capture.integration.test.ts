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

  it('CASO G3: pedido ja PAGO recebendo OUTRO pagamento gera compensacao', async () => {
    // Semantica mudou no review (achado 4.1). Com eventId derivado do
    // paymentId, a redentrega do MESMO pagamento colide no @unique antes de
    // chegar aqui — entao tudo que alcanca a checagem de status e OUTRO
    // pagamento. Confirmar como "ja pago" era cobranca dupla em silencio.
    const o = await pedido(OrderStatus.PAGO);

    const r = await aplicarCaptura(evento(o.id, { paymentId: 'pay_2' }));
    expect(r).toEqual(expect.objectContaining({ tipo: 'compensacao-registrada' }));

    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id } })).toBe(0);
    const pend = await prisma.pendingCompensation.findMany({ where: { orderId: o.id } });
    expect(pend).toHaveLength(1);
    expect(pend[0].reason).toContain('pay_2');
    // A linha do inbox e o registro individual desta captura.
    const linhas = await prisma.inboxEvent.findMany({ where: { orderId: o.id } });
    expect(linhas).toHaveLength(1);
    expect(linhas[0].paymentId).toBe('pay_2');
    expect(linhas[0].amountCents).toBe(10000);
    expect(linhas[0].currency).toBe('BRL');
  });

  it('CASO G4: pedido CANCELADO registra compensacao em vez de transicao', async () => {
    const o = await pedido(OrderStatus.CANCELADO);

    await expect(aplicarCaptura(evento(o.id))).resolves.toEqual(
      expect.objectContaining({ tipo: 'compensacao-registrada' }),
    );

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

    // Evento COERENTE consigo mesmo (autorizado == capturado) e divergente do
    // total do pedido. A checagem de captura parcial roda antes e sombrearia
    // este caso se o evento fosse incoerente — que era o erro original deste
    // teste: ele dizia "valor divergente" e provava "captura parcial".
    await expect(
      aplicarCaptura(evento(o.id, { amountCents: 9900, capturedAmountCents: 9900 })),
    ).resolves.toEqual({ tipo: 'valor-divergente', esperadoCents: 10000, recebidoCents: 9900 });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.PENDENTE);
    expect(await prisma.inboxEvent.count()).toBe(0);
    expect(await prisma.orderStatusHistory.count()).toBe(0);
  });

  it('CASO G7: segunda captura do mesmo pedido cancelado nao duplica pendencia', async () => {
    const o = await pedido(OrderStatus.CANCELADO);

    await aplicarCaptura(evento(o.id, { paymentId: 'pay_1' }));
    await expect(aplicarCaptura(evento(o.id, { paymentId: 'pay_2' }))).resolves.toEqual(
      expect.objectContaining({ tipo: 'compensacao-registrada' }),
    );

    // O unique parcial permite UMA pendencia aberta por pedido.
    expect(await prisma.pendingCompensation.count({ where: { orderId: o.id } })).toBe(1);
    expect(await prisma.inboxEvent.count()).toBe(2);
  });

  it('CASO G8: pedido ENVIADO recebendo captura gera compensacao, nao loop', async () => {
    // ENVIADO so e alcancavel passando por PAGO. Cair em aplicarTransicao
    // lancaria TRANSICAO_INVALIDA -> requeue eterno; confirmar como ja-pago
    // esconderia uma segunda cobranca. Compensacao e a unica saida honesta.
    const o = await pedido(OrderStatus.ENVIADO);

    const r = await aplicarCaptura(evento(o.id, { paymentId: 'pay_3' }));
    expect(r).toEqual(expect.objectContaining({ tipo: 'compensacao-registrada' }));

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.ENVIADO);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id } })).toBe(0);
    expect(await prisma.pendingCompensation.count({ where: { orderId: o.id } })).toBe(1);
  });

  it('CASO G9: moeda divergente NAO deixa marca e NAO muda o pedido', async () => {
    const o = await pedido(OrderStatus.PENDENTE, 100);

    await expect(aplicarCaptura(evento(o.id, { currency: 'USD' }))).resolves.toEqual({
      tipo: 'moeda-divergente',
      esperada: 'BRL',
      recebida: 'USD',
    });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.PENDENTE);
    expect(await prisma.inboxEvent.count()).toBe(0);
  });

  it('CASO G10: captura parcial NAO deixa marca e NAO muda o pedido', async () => {
    // amountCents autorizado != capturedAmountCents. O valor capturado ate bate
    // com o total? Nao importa: parcial nao e representavel no pedido.
    const o = await pedido(OrderStatus.PENDENTE, 100);

    await expect(
      aplicarCaptura(evento(o.id, { amountCents: 20000, capturedAmountCents: 10000 })),
    ).resolves.toEqual({ tipo: 'captura-parcial', autorizadoCents: 20000, capturadoCents: 10000 });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.PENDENTE);
    expect(await prisma.inboxEvent.count()).toBe(0);
  });
});
