import { OrderStatus } from '@prisma/client';
import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';
import { MOTIVO_LIBERACAO_PENDENTE } from '../src/services/order.service';
import { aplicarReembolso } from '../src/services/payment-refund.service';
import { ReembolsoEvent } from '../src/events/payment-events';
import * as inventoryClient from '../src/clients/inventory.client';

// Mesmo motivo do arquivo da expiracao: sem mock, o release cai no catch e cria
// pendencia em TODO caso, mascarando exatamente o que o R1 quer provar.
jest.mock('../src/clients/inventory.client');
const release = inventoryClient.release as jest.MockedFunction<typeof inventoryClient.release>;

/**
 * Representacao do estorno no pedido (Bloco 7b).
 *
 * O que este arquivo prova e o unitario nao alcanca: que o VALOR e a TRANSICAO
 * seguem regras diferentes, que a escrita e monotonica sob eventos fora de
 * ordem, e que so o caminho que transicionou devolve estoque.
 */

beforeAll(() => assertTestDatabase());

beforeEach(() => {
  release.mockReset();
  release.mockResolvedValue(undefined as never);
});

afterEach(async () => {
  await prisma.inboxEvent.deleteMany();
  await prisma.pendingCompensation.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.order.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function pedido(status: OrderStatus = OrderStatus.PAGO, total = 100) {
  return prisma.order.create({ data: { userId: 'u1', status, total } });
}

function evento(orderId: string, over: Partial<ReembolsoEvent> = {}): ReembolsoEvent {
  const providerRefundRef = over.providerRefundRef ?? 're_1';
  return {
    eventId: 'payment.refunded:' + providerRefundRef,
    paymentId: 'pay_1',
    orderId,
    providerRefundRef,
    capturedAmountCents: 10000,
    refundedAmountCents: 4000,
    refundAmountCents: 4000,
    currency: 'BRL',
    occurredAt: '2026-09-10T12:00:00.000Z',
    ...over,
  };
}

const INTEGRAL = { refundedAmountCents: 10000, refundAmountCents: 10000 };

describe('aplicarReembolso — representacao do estorno no pedido', () => {
  it('CASO R1: estorno PARCIAL move o valor, nao muda o status e NAO libera estoque', async () => {
    const o = await pedido(OrderStatus.PAGO);

    await expect(aplicarReembolso(evento(o.id))).resolves.toEqual({ tipo: 'aplicado' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.refundedTotal.toNumber()).toBe(40);
    // Reembolso e atributo de VALOR, nao fase do pedido.
    expect(atual.status).toBe(OrderStatus.PAGO);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id } })).toBe(0);

    // A asercao mais importante do arquivo. `concluirLiberacao` chama o release
    // INCONDICIONALMENTE, entao gatear pelo desfecho publico devolveria a reserva
    // de um pedido ainda PAGO, com mercadoria a expedir.
    expect(release).not.toHaveBeenCalled();
    expect(await prisma.pendingCompensation.count({ where: { orderId: o.id } })).toBe(0);
  });

  it('CASO R2: estorno INTEGRAL de pedido PAGO transiciona e devolve a reserva', async () => {
    const o = await pedido(OrderStatus.PAGO);

    await expect(aplicarReembolso(evento(o.id, INTEGRAL))).resolves.toEqual({ tipo: 'aplicado' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.refundedTotal.toNumber()).toBe(100);
    expect(atual.status).toBe(OrderStatus.REEMBOLSADO);

    const trilha = await prisma.orderStatusHistory.findMany({ where: { orderId: o.id } });
    expect(trilha).toHaveLength(1);
    expect(trilha[0].fromStatus).toBe(OrderStatus.PAGO);
    expect(trilha[0].toStatus).toBe(OrderStatus.REEMBOLSADO);
    // Autoria vem do contexto, nunca do payload.
    expect(trilha[0].changedBy).toBe('payment-service');

    // Dinheiro voltou inteiro e a mercadoria nunca saiu: segurar a reserva
    // deixaria o pedido pendurado, a classe de bug do Bloco 6.
    expect(release).toHaveBeenCalledWith(o.id);
    const pend = await prisma.pendingCompensation.findMany({ where: { orderId: o.id } });
    expect(pend).toHaveLength(1);
    expect(pend[0].reason).toContain(MOTIVO_LIBERACAO_PENDENTE);
    expect(pend[0].resolvedAt).not.toBeNull();
  });

  it('CASO R3: evento com total MENOR chegando depois e no-op, nao regressao', async () => {
    const o = await pedido(OrderStatus.PAGO);

    // O acumulado MAIOR chega primeiro; o menor, depois. Num broker isso
    // acontece, e o inbox nao ajuda: sao eventos DIFERENTES.
    await aplicarReembolso(
      evento(o.id, { providerRefundRef: 're_2', refundedAmountCents: 7000, refundAmountCents: 3000 }),
    );
    await expect(
      aplicarReembolso(evento(o.id, { providerRefundRef: 're_1' })),
    ).resolves.toEqual({ tipo: 'aplicado' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    // Sem o `lt` no where, o segundo evento levaria o total de 70 de volta a 40.
    expect(atual.refundedTotal.toNumber()).toBe(70);
    // Os dois sao eventos legitimos e distintos: ambos marcam o inbox.
    expect(await prisma.inboxEvent.count({ where: { orderId: o.id } })).toBe(2);
  });

  it('CASO R4: reentrega do MESMO evento e duplicata, sem segundo efeito', async () => {
    const o = await pedido(OrderStatus.PAGO);
    const ev = evento(o.id);

    await expect(aplicarReembolso(ev)).resolves.toEqual({ tipo: 'aplicado' });
    await expect(aplicarReembolso(ev)).resolves.toEqual({ tipo: 'duplicata' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.refundedTotal.toNumber()).toBe(40);
    expect(await prisma.inboxEvent.count({ where: { orderId: o.id } })).toBe(1);
  });

  it('CASO R5: estorno INTEGRAL de pedido ENVIADO registra pendencia e nao expede status', async () => {
    const o = await pedido(OrderStatus.ENVIADO);

    const r = await aplicarReembolso(evento(o.id, INTEGRAL));
    expect(r).toMatchObject({ tipo: 'compensacao-registrada' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    // O VALOR se move mesmo assim: mercadoria na rua nao muda o fato de o
    // dinheiro ter voltado.
    expect(atual.refundedTotal.toNumber()).toBe(100);
    expect(atual.status).toBe(OrderStatus.ENVIADO);

    // Devolver unidade ao estoque sem ela ter voltado fisicamente e inventar
    // inventario. Isto e devolucao, e exige gente.
    expect(release).not.toHaveBeenCalled();
    const pend = await prisma.pendingCompensation.findMany({ where: { orderId: o.id } });
    expect(pend).toHaveLength(1);
    expect(pend[0].reason).toContain('estorno_integral_para_pedido_enviado');
  });

  it('CASO R6: estorno INTEGRAL de pedido CANCELADO move o valor sem forcar transicao', async () => {
    const o = await pedido(OrderStatus.CANCELADO);

    await expect(aplicarReembolso(evento(o.id, INTEGRAL))).resolves.toEqual({ tipo: 'aplicado' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.refundedTotal.toNumber()).toBe(100);
    // Forcar REEMBOLSADO apagaria a razao real do fim do pedido.
    expect(atual.status).toBe(OrderStatus.CANCELADO);
    expect(release).not.toHaveBeenCalled();
    expect(await prisma.pendingCompensation.count({ where: { orderId: o.id } })).toBe(0);
  });
});
