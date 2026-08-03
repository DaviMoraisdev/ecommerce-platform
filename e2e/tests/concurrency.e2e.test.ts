import {
  mintToken, key, seedProduct, cleanupProduct, setStock, getStock, addToCart, createOrder, health,
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

describe('e2e - concorrencia na reserva (sem oversell)', () => {
  it('estoque=1, N concorrentes -> 1 sucesso, resto 409-estoque, sem oversell', async () => {
    const productId = await newProduct(15, 1);
    const N = 5;
    const users = Array.from({ length: N }, () => mintToken('u-' + key(), 'ADMIN'));
    for (const u of users) expect((await addToCart(u, productId, 1)).status).toBe(200);

    const results = await Promise.all(users.map((u) => createOrder(u, key('idem'))));
    const criados = results.filter((r) => r.status === 201);
    const conflitos = results.filter((r) => r.status === 409);
    expect(criados).toHaveLength(1);
    expect(conflitos).toHaveLength(N - 1);
    for (const c of conflitos) expect(String(c.body?.error ?? '')).toMatch(/insuficiente/i);

    const stock = await getStock(productId);
    expect(stock.reserved).toBe(1);
    expect(stock.available).toBe(0);
  });

  it('estoque=3, 5 concorrentes -> 3 sucessos, 2 conflitos-estoque, reservado=3', async () => {
    const productId = await newProduct(20, 3);
    const N = 5;
    const users = Array.from({ length: N }, () => mintToken('u-' + key(), 'ADMIN'));
    for (const u of users) expect((await addToCart(u, productId, 1)).status).toBe(200);

    const results = await Promise.all(users.map((u) => createOrder(u, key('idem'))));
    const conflitos = results.filter((r) => r.status === 409);
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(conflitos).toHaveLength(2);
    for (const c of conflitos) expect(String(c.body?.error ?? '')).toMatch(/insuficiente/i);

    const stock = await getStock(productId);
    expect(stock.reserved).toBe(3);
    expect(stock.available).toBe(0);
  });

  it('idempotencia sob concorrencia: mesma chave+usuario simultaneo -> uma reserva', async () => {
    const token = mintToken('u-' + key(), 'ADMIN');
    const productId = await newProduct(10, 5);
    expect((await addToCart(token, productId, 1)).status).toBe(200);

    const k = key('idem');
    const [a, b] = await Promise.all([createOrder(token, k), createOrder(token, k)]);

    // Contrato: cada resposta e 201 (criado/mesmo pedido) ou 409 (em processamento).
    for (const r of [a, b]) expect([201, 409]).toContain(r.status);
    const criados = [a, b].filter((r) => r.status === 201);
    expect(criados.length).toBeGreaterThanOrEqual(1);
    if (a.status === 201 && b.status === 201) expect(a.body.id).toBe(b.body.id);
    for (const r of [a, b]) {
      if (r.status === 409) expect(String(r.body?.error ?? '')).toMatch(/processamento|andamento/i);
    }
    expect((await getStock(productId)).reserved).toBe(1);

    // replay posterior com a MESMA chave -> retorna o pedido original (idempotencia completa)
    const winner = [a, b].find((r) => r.status === 201)!;
    const replay = await createOrder(token, k);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(winner.body.id);
  });
});
