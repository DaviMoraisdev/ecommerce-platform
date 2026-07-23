import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

import { prisma } from '../src/config/database';
import { reserveStock, releaseByOrder, setStock } from '../src/services/stock.service';

describe('concorrencia', () => {
  const P = 'test-conc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  afterEach(async () => {
    await prisma.reservation.deleteMany({ where: { productId: P } });
    await prisma.inventory.deleteMany({ where: { productId: P } });
  });

  it('duas reservas do ultimo item: so uma passa (e so uma Reservation)', async () => {
    await setStock(P, 1);
    const r = await Promise.allSettled([
      reserveStock(P, 1, 'order-A'),
      reserveStock(P, 1, 'order-B'),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    const inv = await prisma.inventory.findUnique({ where: { productId: P } });
    expect(inv?.reserved).toBe(1);
    expect(await prisma.reservation.count({ where: { productId: P } })).toBe(1);
  });

  it('mesmo pedido+produto em paralelo: debita uma vez so (rollback/idempotencia)', async () => {
    await setStock(P, 10);
    const r = await Promise.allSettled([
      reserveStock(P, 3, 'order-X'),
      reserveStock(P, 3, 'order-X'),
    ]);
    expect(r.some((x) => x.status === 'fulfilled')).toBe(true);
    const inv = await prisma.inventory.findUnique({ where: { productId: P } });
    expect(inv?.reserved).toBe(3); // nao 6
    expect(
      await prisma.reservation.count({ where: { productId: P, status: 'ACTIVE' } })
    ).toBe(1);
  });

  it('duas releases simultaneas do mesmo pedido: estoque devolvido uma vez so', async () => {
    await setStock(P, 10);
    await reserveStock(P, 4, 'order-R');
    const r = await Promise.allSettled([
      releaseByOrder('order-R'),
      releaseByOrder('order-R'),
    ]);
    const releaseds = r
      .filter((x) => x.status === 'fulfilled')
      .map((x) => (x as PromiseFulfilledResult<{ released: number }>).value.released)
      .sort();
    expect(releaseds).toEqual([0, 1]); // uma processa, a outra reivindica 0
    const inv = await prisma.inventory.findUnique({ where: { productId: P } });
    expect(inv?.reserved).toBe(0); // devolvido 1x, nao -4
  });
});
