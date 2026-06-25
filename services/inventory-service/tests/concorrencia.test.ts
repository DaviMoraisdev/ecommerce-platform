import dotenv from 'dotenv';
dotenv.config();

import { prisma } from '../src/config/database';
import { reserveStock, setStock } from '../src/services/stock.service';

describe('reserveStock - concorrencia', () => {
  const PRODUCT_ID = 'test-concorrencia-' + Date.now();

  beforeEach(async () => {
    await setStock(PRODUCT_ID, 1);
  });

  afterEach(async () => {
    await prisma.inventory.deleteMany({ where: { productId: PRODUCT_ID } });
  });

  it('duas reservas simultaneas do ultimo item: apenas uma deve passar', async () => {
    const resultados = await Promise.allSettled([
      reserveStock(PRODUCT_ID, 1),
      reserveStock(PRODUCT_ID, 1),
    ]);

    const sucessos = resultados.filter((r) => r.status === 'fulfilled');
    const falhas = resultados.filter((r) => r.status === 'rejected');

    expect(sucessos).toHaveLength(1);
    expect(falhas).toHaveLength(1);

    const falha = falhas[0] as PromiseRejectedResult;
    expect(falha.reason.message).toBe('INSUFFICIENT_STOCK');

    const final = await prisma.inventory.findUnique({
      where: { productId: PRODUCT_ID },
    });
    expect(final?.reserved).toBe(1);
    expect(final?.quantity).toBe(1);
  });
});
