import {
  mintToken,
  key,
  seedProduct,
  setStock,
  getStock,
  addToCart,
  getCart,
  createOrder,
  health,
} from '../src/helpers';

describe('e2e - happy path (cart -> order -> inventory)', () => {
  beforeAll(async () => {
    const h = await health();
    const down = Object.entries(h).filter(([, s]) => s !== 200);
    if (down.length) {
      throw new Error('stack incompleto (esperado 200 em todos): ' + JSON.stringify(h));
    }
  });

  it('produto+estoque -> carrinho -> pedido 201 -> estoque reservado e carrinho limpo', async () => {
    const token = mintToken('u-' + key(), 'ADMIN');

    const productId = await seedProduct(token, 25);
    await setStock(token, productId, 10);

    const add = await addToCart(token, productId, 2);
    expect(add.status).toBe(200);

    const cart = await getCart(token);
    expect(cart.status).toBe(200);
    expect(cart.body.total).toBe(50);
    expect(cart.body.partial).toBe(false);

    const order = await createOrder(token, key('idem'));
    expect(order.status).toBe(201);
    expect(order.body.status).toBe('PENDENTE');
    expect(Number(order.body.total)).toBe(50);
    expect(order.body.items).toHaveLength(1);

    // estoque: 2 reservados de 10 -> 8 disponiveis
    const stock = await getStock(productId);
    expect(stock.reserved).toBe(2);
    expect(stock.available).toBe(8);

    // carrinho limpo (o item comprado foi removido)
    const after = await getCart(token);
    expect(after.body.items).toHaveLength(0);
  });

  it('idempotencia: mesma Idempotency-Key retorna o mesmo pedido, sem reservar de novo', async () => {
    const token = mintToken('u-' + key(), 'ADMIN');
    const productId = await seedProduct(token, 10);
    await setStock(token, productId, 5);
    await addToCart(token, productId, 1);

    const k = key('idem');
    const a = await createOrder(token, k);
    const b = await createOrder(token, k);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id); // mesmo pedido

    const stock = await getStock(productId);
    expect(stock.reserved).toBe(1); // reservou UMA vez so
  });
});
