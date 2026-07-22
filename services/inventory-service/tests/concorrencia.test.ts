import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

import { prisma } from '../src/config/database';
import { reserveStock, setStock } from '../src/services/stock.service';

describe('reserveStock - concorrencia', () => {
  const PRODUCT_ID = 'test-concorrencia-' + Date.now();
  beforeEach(async () => {
    await setStock(PRODUCT_ID, 1);
  });
  afterEach(async () => {
    await prisma.reservation.deleteMany({ where: { productId: PRODUCT_ID } });
    await prisma.inventory.deleteMany({ where: { productId: PRODUCT_ID } });
  });

  it('duas reservas simultaneas do ultimo item: apenas uma passa', async () => {
    const resultados = await Promise.allSettled([
      reserveStock(PRODUCT_ID, 1, 'order-A'),
      reserveStock(PRODUCT_ID, 1, 'order-B'),
    ]);
    const sucessos = resultados.filter((r) => r.status === 'fulfilled');
    const falhas = resultados.filter((r) => r.status === 'rejected');
    expect(sucessos).toHaveLength(1);
    expect(falhas).toHaveLength(1);
    expect((falhas[0] as PromiseRejectedResult).reason.message).toBe('INSUFFICIENT_STOCK');

    const final = await prisma.inventory.findUnique({ where: { productId: PRODUCT_ID } });
    expect(final?.reserved).toBe(1);
    // Prova adicional: existe exatamente UMA reserva (a do vencedor) — a
    // transacao do perdedor reverteu tambem a linha de Reservation.
    const reservas = await prisma.reservation.findMany({ where: { productId: PRODUCT_ID } });
    expect(reservas).toHaveLength(1);
  });
});
