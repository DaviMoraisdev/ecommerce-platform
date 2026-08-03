import {
  mintToken, key, seedProduct, cleanupProduct, setStock, getStock,
  addToCart, createOrder, registerAndLogin, health,
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

describe('e2e - jornada com auth-service (login real)', () => {
  it('usuario registrado+logado compra usando o token do auth-service', async () => {
    const productId = await newProduct(30, 5);

    const { token, userId } = await registerAndLogin();

    expect((await addToCart(token, productId, 1)).status).toBe(200);
    const order = await createOrder(token, key('idem'));
    expect(order.status).toBe(201);
    expect(order.body.userId).toBe(userId); // pedido do usuario real (id do token do auth)

    expect((await getStock(productId)).reserved).toBe(1);
  });
});
