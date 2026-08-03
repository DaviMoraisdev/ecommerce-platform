import jwt from 'jsonwebtoken';
import {
  mintToken, key, seedProduct, cleanupProduct, setStock, getStock,
  addToCart, getCart, createOrder, health, request, URLS,
} from '../src/helpers';

const admin = mintToken('admin-' + key(), 'ADMIN');
const created: string[] = [];

async function newProduct(price: number, stock: number): Promise<string> {
  const id = await seedProduct(admin, price);
  created.push(id);
  await setStock(admin, id, stock);
  return id;
}

beforeAll(async () => {
  const h = await health();
  const down = Object.entries(h).filter(([, s]) => s !== 200);
  if (down.length) throw new Error('stack incompleto: ' + JSON.stringify(h));
});

afterAll(async () => {
  for (const id of created) await cleanupProduct(admin, id).catch(() => undefined);
});

describe('e2e - happy path (cart -> order -> inventory)', () => {
  it('produto+estoque -> carrinho -> pedido 201 -> reserva e carrinho limpo', async () => {
    const token = mintToken('u-' + key(), 'ADMIN');
    const productId = await newProduct(25, 10);

    expect((await addToCart(token, productId, 2)).status).toBe(200);
    const cart = await getCart(token);
    expect(cart.status).toBe(200);
    expect(cart.body.total).toBe(50);
    expect(cart.body.partial).toBe(false);

    const order = await createOrder(token, key('idem'));
    expect(order.status).toBe(201);
    expect(order.body.status).toBe('PENDENTE');
    expect(Number(order.body.total)).toBe(50);
    expect(order.body.items).toHaveLength(1);

    const stock = await getStock(productId);
    expect(stock.reserved).toBe(2);
    expect(stock.available).toBe(8);
    expect((await getCart(token)).body.items).toHaveLength(0);
  });

  it('idempotencia sequencial: mesma chave -> mesmo pedido, reserva uma vez', async () => {
    const token = mintToken('u-' + key(), 'ADMIN');
    const productId = await newProduct(10, 5);
    expect((await addToCart(token, productId, 1)).status).toBe(200);

    const k = key('idem');
    const a = await createOrder(token, k);
    const b = await createOrder(token, k);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect((await getStock(productId)).reserved).toBe(1);
  });
});

describe('e2e - auth', () => {
  it('sem token -> 401', async () => {
    expect((await request('GET', URLS.cart + '/cart')).status).toBe(401);
  });
  it('token invalido -> 401', async () => {
    expect((await request('GET', URLS.cart + '/cart', { token: 'lixo.invalido' })).status).toBe(401);
  });

  it('token expirado -> 401', async () => {
    const expirado = mintToken('u-' + key(), 'ADMIN', -1);
    expect((await request('GET', URLS.cart + '/cart', { token: expirado })).status).toBe(401);
  });

  it('token com assinatura invalida -> 401', async () => {
    const forjado = jwt.sign({ id: 'u1', role: 'ADMIN' }, 'segredo-errado', { expiresIn: '1h' });
    expect((await request('GET', URLS.cart + '/cart', { token: forjado })).status).toBe(401);
  });
  it('nao-admin (USER) nao seta estoque -> 403', async () => {
    const user = mintToken('u-' + key(), 'USER');
    const r = await request('POST', URLS.inventory + '/stock', { token: user, body: { productId: 'x', quantity: 1 } });
    expect(r.status).toBe(403);
  });
  it('nao-admin (USER) completa a compra -> 201', async () => {
    const productId = await newProduct(15, 3);
    const user = mintToken('u-' + key(), 'USER');
    expect((await addToCart(user, productId, 1)).status).toBe(200);
    expect((await createOrder(user, key('idem'))).status).toBe(201);
  });
});
