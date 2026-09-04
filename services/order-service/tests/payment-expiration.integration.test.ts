import { OrderStatus } from '@prisma/client';
import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';
import { aplicarExpiracao } from '../src/services/payment-expiration.service';
import { ExpiracaoEvent } from '../src/events/payment-events';
import * as inventoryClient from '../src/clients/inventory.client';

// O release e chamada HTTP ao inventory. Sem mock, cairia no catch e criaria
// pendencia em TODO caso — mascarando exatamente o que o CASO X6 quer provar.
jest.mock('../src/clients/inventory.client');
const release = inventoryClient.release as jest.MockedFunction<typeof inventoryClient.release>;

/**
 * Compensacao da saga por expiracao (Bloco 6f).
 *
 * O que este arquivo prova e o unitario nao pode: que os desfechos sem efeito
 * DESFAZEM o insert do inbox, que o pedido PAGO nao e tocado, e que a falha do
 * release deixa pendencia DURAVEL sem desfazer o cancelamento.
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

async function pedido(status: OrderStatus = OrderStatus.PENDENTE, total = 100) {
  return prisma.order.create({ data: { userId: 'u1', status, total } });
}

function evento(orderId: string, over: Partial<ExpiracaoEvent> = {}): ExpiracaoEvent {
  const paymentId = over.paymentId ?? 'pay_1';
  return {
    eventId: 'payment.expired:' + paymentId,
    paymentId,
    orderId,
    amountCents: 10000,
    currency: 'BRL',
    occurredAt: '2026-09-04T12:00:00.000Z',
    ...over,
  };
}

describe('aplicarExpiracao — compensacao da saga', () => {
  it('CASO X1: PENDENTE vira CANCELADO e o estoque e liberado', async () => {
    const o = await pedido();

    await expect(aplicarExpiracao(evento(o.id))).resolves.toEqual({ tipo: 'aplicado' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.CANCELADO);

    const trilha = await prisma.orderStatusHistory.findMany({ where: { orderId: o.id } });
    expect(trilha).toHaveLength(1);
    expect(trilha[0].fromStatus).toBe(OrderStatus.PENDENTE);
    expect(trilha[0].toStatus).toBe(OrderStatus.CANCELADO);
    // Autoria vem do contexto, nunca do payload.
    expect(trilha[0].changedBy).toBe('payment-service');

    expect(await prisma.inboxEvent.count({ where: { orderId: o.id } })).toBe(1);
    // Sem esta chamada o pedido some do fluxo mas a mercadoria continua reservada.
    expect(release).toHaveBeenCalledWith(o.id);
    expect(await prisma.pendingCompensation.count({ where: { orderId: o.id } })).toBe(0);
  });

  it('CASO X2: reentrega do MESMO evento e duplicata, sem segundo cancelamento', async () => {
    const o = await pedido();
    await aplicarExpiracao(evento(o.id));

    await expect(aplicarExpiracao(evento(o.id))).resolves.toEqual({ tipo: 'duplicata' });

    expect(await prisma.inboxEvent.count({ where: { orderId: o.id } })).toBe(1);
    const trilha = await prisma.orderStatusHistory.findMany({ where: { orderId: o.id } });
    expect(trilha).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('CASO X3: pedido JA CANCELADO nao deixa marca de inbox', async () => {
    // O efeito desejado existe, mas NAO foi produzido por este evento. Gravar a
    // marca faria a reentrega ser lida como duplicata de algo que nunca agiu —
    // o invariante do inbox e "linha existe se e somente se o efeito aconteceu".
    const o = await pedido(OrderStatus.CANCELADO);

    await expect(aplicarExpiracao(evento(o.id))).resolves.toEqual({ tipo: 'ja-cancelado' });

    expect(await prisma.inboxEvent.count({ where: { orderId: o.id } })).toBe(0);
    expect(release).not.toHaveBeenCalled();
  });

  it('CASO X4: pedido PAGO NUNCA e cancelado por expiracao', async () => {
    // O caso central do bloco. A matriz de estados PERMITE PAGO -> CANCELADO,
    // entao nada alem deste teste impede alguem de "simplificar" o handler e
    // passar a liberar estoque de mercadoria JA COBRADA.
    const o = await pedido(OrderStatus.PAGO);

    const resultado = await aplicarExpiracao(evento(o.id));
    expect(resultado).toMatchObject({ tipo: 'compensacao-registrada' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.PAGO);
    expect(release).not.toHaveBeenCalled();

    const pendencias = await prisma.pendingCompensation.findMany({ where: { orderId: o.id } });
    expect(pendencias).toHaveLength(1);
    expect(pendencias[0].reason).toContain('expiracao_para_pedido_pago');
  });

  it('CASO X5: valor divergente NAO cancela — cancelar e destrutivo', async () => {
    // Libera estoque. Um evento cujo valor nao bate pode ser de outro pedido, e
    // agir nele e pior que nao agir.
    const o = await pedido();

    await expect(aplicarExpiracao(evento(o.id, { amountCents: 9999 }))).resolves.toMatchObject({
      tipo: 'valor-divergente',
    });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.PENDENTE);
    expect(await prisma.inboxEvent.count({ where: { orderId: o.id } })).toBe(0);
    expect(release).not.toHaveBeenCalled();
  });

  it('CASO X6: release que falha deixa pendencia DURAVEL e nao desfaz o cancelamento', async () => {
    // O status e a fonte da verdade. Reverter o cancelamento porque o inventory
    // esta fora deixaria o pagamento EXPIRED e o pedido PENDENTE — o pior dos
    // dois mundos. A pendencia cobre a reconciliacao.
    release.mockRejectedValue(new Error('inventory indisponivel') as never);
    const o = await pedido();

    await expect(aplicarExpiracao(evento(o.id))).resolves.toEqual({ tipo: 'aplicado' });

    const atual = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(atual.status).toBe(OrderStatus.CANCELADO);

    const pendencias = await prisma.pendingCompensation.findMany({ where: { orderId: o.id } });
    expect(pendencias).toHaveLength(1);
    expect(pendencias[0].reason).toContain('cancel_release_falhou');
  });
});
