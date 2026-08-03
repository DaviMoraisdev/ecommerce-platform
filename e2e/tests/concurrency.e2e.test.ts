import {
  mintToken,
  key,
  seedProduct,
  setStock,
  getStock,
  addToCart,
  createOrder,
  health,
} from '../src/helpers';

describe('e2e - concorrencia na reserva (sem oversell)', () => {
  beforeAll(async () => {
    const h = await health();
    const down = Object.entries(h).filter(([, s]) => s !== 200);
    if (down.length) {
      throw new Error('stack incompleto: ' + JSON.stringify(h));
    }
  });

  it('estoque=1, N pedidos concorrentes -> exatamente 1 sucesso, resto 409, sem oversell', async () => {
    const admin = mintToken('admin-' + key(), 'ADMIN');
    const productId = await seedProduct(admin, 15);
    await setStock(admin, productId, 1);

    const N = 5;
    // N usuarios distintos, cada um com 1 unidade no proprio carrinho
    const users = Array.from({ length: N }, () => mintToken('u-' + key(), 'ADMIN'));
    for (const u of users) {
      const add = await addToCart(u, productId, 1);
      expect(add.status).toBe(200);
    }

    // dispara os N checkouts CONCORRENTEMENTE (disputam o mesmo estoque=1)
    const results = await Promise.all(users.map((u) => createOrder(u, key('idem'))));
    const statuses = results.map((r) => r.status);
    const criados = statuses.filter((s) => s === 201).length;
    const conflitos = statuses.filter((s) => s === 409).length;

    // exatamente um vence; os demais recebem conflito de estoque
    expect(criados).toBe(1);
    expect(conflitos).toBe(N - 1);

    // sem OVERSELL: 1 reservado, 0 disponivel
    const stock = await getStock(productId);
    expect(stock.reserved).toBe(1);
    expect(stock.available).toBe(0);
  });

  it('estoque=3, 5 pedidos concorrentes de 1 un -> 3 sucessos, 2 conflitos, reservado=3', async () => {
    const admin = mintToken('admin-' + key(), 'ADMIN');
    const productId = await seedProduct(admin, 20);
    await setStock(admin, productId, 3);

    const N = 5;
    const users = Array.from({ length: N }, () => mintToken('u-' + key(), 'ADMIN'));
    for (const u of users) {
      expect((await addToCart(u, productId, 1)).status).toBe(200);
    }

    const results = await Promise.all(users.map((u) => createOrder(u, key('idem'))));
    const criados = results.filter((r) => r.status === 201).length;
    const conflitos = results.filter((r) => r.status === 409).length;

    expect(criados).toBe(3);
    expect(conflitos).toBe(2);

    const stock = await getStock(productId);
    expect(stock.reserved).toBe(3);
    expect(stock.available).toBe(0);
  });
});
