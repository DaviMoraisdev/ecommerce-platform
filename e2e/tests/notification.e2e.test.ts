import {
  mintToken, key, seedProduct, cleanupProduct, setStock,
  addToCart, createOrder, waitForNotification, closeRedis, health,
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
  await closeRedis();
});

describe('e2e - notification-service consome o evento do pedido', () => {
  it('criar pedido -> outbox -> relay -> broker -> consumer marca como processado', async () => {
    const token = mintToken('u-' + key(), 'ADMIN');
    const productId = await newProduct(20, 5);
    expect((await addToCart(token, productId, 1)).status).toBe(200);

    const order = await createOrder(token, key('idem'));
    expect(order.status).toBe(201);

    const consumed = await waitForNotification(order.body.id, 'order.created');
    expect(consumed).toBe(true);
  });
});
