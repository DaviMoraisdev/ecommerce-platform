import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';

beforeAll(() => {
  assertTestDatabase();
});

afterEach(async () => {
  await prisma.order.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('schema / migrations (Postgres real)', () => {
  it('order nasce PENDENTE e preserva o decimal (2 casas)', async () => {
    const order = await prisma.order.create({
      data: { userId: 'u1', total: '31.50' },
    });
    expect(order.status).toBe('PENDENTE');
    // toFixed(2) preserva a semantica decimal (nao converte para float).
    expect(order.total.toFixed(2)).toBe('31.50');
  });

  it('cascade: apagar a order remove os itens', async () => {
    const order = await prisma.order.create({
      data: {
        userId: 'u1',
        total: '21.00',
        items: {
          create: [
            { productId: 'p1', quantity: 2, unitPrice: '10.50', subtotal: '21.00' },
          ],
        },
      },
    });
    await prisma.order.delete({ where: { id: order.id } });
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toHaveLength(0);
  });

  it('rejeita quantity <= 0 pela constraint quantity_positiva', async () => {
    const order = await prisma.order.create({ data: { userId: 'u1', total: '0.00' } });
    await expect(
      prisma.orderItem.create({
        data: { orderId: order.id, productId: 'p1', quantity: 0, unitPrice: '10.00', subtotal: '0.00' },
      })
    ).rejects.toThrow(/quantity_positiva/);
  });

  it('rejeita subtotal inconsistente pela constraint subtotal_consistente', async () => {
    const order = await prisma.order.create({ data: { userId: 'u1', total: '0.00' } });
    await expect(
      prisma.orderItem.create({
        data: { orderId: order.id, productId: 'p1', quantity: 2, unitPrice: '10.00', subtotal: '99.00' },
      })
    ).rejects.toThrow(/subtotal_consistente/);
  });

  it('rejeita total negativo pela constraint total_nao_negativo', async () => {
    await expect(
      prisma.order.create({ data: { userId: 'u1', total: '-1.00' } })
    ).rejects.toThrow(/total_nao_negativo/);
  });
});
