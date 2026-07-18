import { prisma } from '../src/config/database';

// Guard: JAMAIS rodar contra um banco que nao seja de teste.
beforeAll(() => {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('order_test_db')) {
    throw new Error(
      'Integracao exige order_test_db; DATABASE_URL atual nao e de teste — abortado.'
    );
  }
});

afterEach(async () => {
  // Cascade remove os itens ao apagar as orders.
  await prisma.order.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('schema / migrations (Postgres real)', () => {
  it('order nasce com status PENDENTE e Decimal exato', async () => {
    const order = await prisma.order.create({
      data: { userId: 'u1', total: '31.50' },
    });
    expect(order.status).toBe('PENDENTE');
    expect(Number(order.total)).toBe(31.5);
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

  it('rejeita quantity <= 0 (constraint quantity_positiva)', async () => {
    const order = await prisma.order.create({ data: { userId: 'u1', total: '0.00' } });
    await expect(
      prisma.orderItem.create({
        data: { orderId: order.id, productId: 'p1', quantity: 0, unitPrice: '10.00', subtotal: '0.00' },
      })
    ).rejects.toThrow();
  });

  it('rejeita subtotal inconsistente (subtotal != unitPrice*quantity)', async () => {
    const order = await prisma.order.create({ data: { userId: 'u1', total: '0.00' } });
    await expect(
      prisma.orderItem.create({
        data: { orderId: order.id, productId: 'p1', quantity: 2, unitPrice: '10.00', subtotal: '99.00' },
      })
    ).rejects.toThrow();
  });

  it('rejeita total negativo (constraint total_nao_negativo)', async () => {
    await expect(
      prisma.order.create({ data: { userId: 'u1', total: '-1.00' } })
    ).rejects.toThrow();
  });
});
