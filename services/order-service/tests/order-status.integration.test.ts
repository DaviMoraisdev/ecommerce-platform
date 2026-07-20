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

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(resultados.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // E o historico registra exatamente UMA transicao.
    expect(await getStatusHistory(order.id)).toHaveLength(1);
  });
});
