import { OrderStatus } from '@prisma/client';
import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';
import { updateOrderStatus, getStatusHistory } from '../src/services/order.service';

beforeAll(() => {
  assertTestDatabase();
});

afterEach(async () => {
  await prisma.order.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function novoPedido() {
  return prisma.order.create({ data: { userId: 'u1', total: '10.00' } });
}

describe('updateOrderStatus', () => {
  it('aplica transicao valida e registra o historico', async () => {
    const order = await novoPedido();
    const atualizado = await updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1');

    expect(atualizado.status).toBe(OrderStatus.PAGO);
    const hist = await getStatusHistory(order.id);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      fromStatus: OrderStatus.PENDENTE,
      toStatus: OrderStatus.PAGO,
      changedBy: 'admin1',
    });
  });

  it('rejeita pulo invalido sem alterar status nem gravar historico', async () => {
    const order = await novoPedido();
    await expect(
      updateOrderStatus(order.id, OrderStatus.ENVIADO, 'admin1')
    ).rejects.toThrow('TRANSICAO_INVALIDA');

    const depois = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(depois.status).toBe(OrderStatus.PENDENTE);
    expect(await getStatusHistory(order.id)).toHaveLength(0);
  });

  it('rejeita pedido inexistente', async () => {
    await expect(
      updateOrderStatus('nao-existe', OrderStatus.PAGO, 'admin1')
    ).rejects.toThrow('PEDIDO_NAO_ENCONTRADO');
  });

  it('acumula o caminho completo no historico, em ordem', async () => {
    const order = await novoPedido();
    await updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1');
    await updateOrderStatus(order.id, OrderStatus.ENVIADO, 'admin1');
    await updateOrderStatus(order.id, OrderStatus.ENTREGUE, 'admin1');

    const hist = await getStatusHistory(order.id);
    expect(hist.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [OrderStatus.PENDENTE, OrderStatus.PAGO],
      [OrderStatus.PAGO, OrderStatus.ENVIADO],
      [OrderStatus.ENVIADO, OrderStatus.ENTREGUE],
    ]);
  });

  it('status terminal nao aceita nova transicao', async () => {
    const order = await novoPedido();
    await updateOrderStatus(order.id, OrderStatus.CANCELADO, 'admin1');
    await expect(
      updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1')
    ).rejects.toThrow('TRANSICAO_INVALIDA');
  });

  it('concorrencia: a MESMA transicao aplicada 2x so vale uma vez', async () => {
    const order = await novoPedido();
    // Alvos iguais de proposito: PAGO e CANCELADO formariam uma cadeia valida
    // (PENDENTE->PAGO->CANCELADO) e as duas passariam legitimamente.
    // Disputando a MESMA transicao, so uma pode vencer:
    //  - em paralelo real: o CAS da segunda casa 0 linhas -> CONFLITO_DE_ESTADO
    //  - se serializar: a segunda le PAGO e tenta PAGO->PAGO -> TRANSICAO_INVALIDA
    const resultados = await Promise.allSettled([
      updateOrderStatus(order.id, OrderStatus.PAGO, 'u1'),
      updateOrderStatus(order.id, OrderStatus.PAGO, 'u2'),
    ]);

    const vencedores = resultados.filter((r) => r.status === 'fulfilled');
    const perdedores = resultados.filter((r) => r.status === 'rejected');
    expect(vencedores).toHaveLength(1);
    expect(perdedores).toHaveLength(1);

    // O motivo da rejeicao tem que ser um dos dois esperados (por CODIGO).
    const motivo = (perdedores[0] as PromiseRejectedResult).reason;
    expect(['CONFLITO_DE_ESTADO', 'TRANSICAO_INVALIDA']).toContain(motivo.code);

    // Estado final e trilha coerentes com UMA unica transicao vencedora.
    const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(final.status).toBe(OrderStatus.PAGO);
    const hist = await getStatusHistory(order.id);
    expect(hist).toHaveLength(1);
    expect(['u1', 'u2']).toContain(hist[0].changedBy);
  });

  it('rejeita changedBy vazio ou so espacos', async () => {
    const order = await novoPedido();
    await expect(
      updateOrderStatus(order.id, OrderStatus.PAGO, '   ')
    ).rejects.toThrow('AUTOR_INVALIDO');
    expect(await getStatusHistory(order.id)).toHaveLength(0);
  });

  it('rejeita changedBy longo demais', async () => {
    const order = await novoPedido();
    await expect(
      updateOrderStatus(order.id, OrderStatus.PAGO, 'x'.repeat(129))
    ).rejects.toThrow('AUTOR_INVALIDO');
  });

  it('ordena por sequencia mesmo com createdAt identico', async () => {
    const order = await novoPedido();
    const t = new Date();
    await prisma.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: OrderStatus.PENDENTE, toStatus: OrderStatus.PAGO, changedBy: 'a', createdAt: t },
    });
    await prisma.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: OrderStatus.PAGO, toStatus: OrderStatus.ENVIADO, changedBy: 'b', createdAt: t },
    });
    const hist = await getStatusHistory(order.id);
    expect(hist.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [OrderStatus.PENDENTE, OrderStatus.PAGO],
      [OrderStatus.PAGO, OrderStatus.ENVIADO],
    ]);
  });

  it('banco rejeita historico com fromStatus == toStatus', async () => {
    const order = await novoPedido();
    await expect(
      prisma.orderStatusHistory.create({
        data: { orderId: order.id, fromStatus: OrderStatus.PAGO, toStatus: OrderStatus.PAGO, changedBy: 'a' },
      })
    ).rejects.toThrow(/historico_status_diferente/);
  });

  it('politica deliberada: apagar o pedido remove a trilha (cascade)', async () => {
    const order = await novoPedido();
    await updateOrderStatus(order.id, OrderStatus.PAGO, 'admin1');
    expect(await getStatusHistory(order.id)).toHaveLength(1);
    await prisma.order.delete({ where: { id: order.id } });
    expect(await getStatusHistory(order.id)).toHaveLength(0);
  });
});
