import request from 'supertest';
import app from '../src/app';
import { authHeader } from './helpers/auth';

// Testa rotas HTTP do stock: mapeamento de status (400/401/403/404/409) e
// autorizacao. App importado sem subir servidor (Supertest). Banco:
// inventory_test_db isolado (setup.ts com salvaguarda). REQUER Docker/Postgres
// ativo. Tokens sao JWT reais assinados com o JWT_SECRET do .env.test.

function pid(suffix: string): string {
  return `prod-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Helpers de setup via API (setStock ja validado no grupo de autorizacao).
async function seedStock(productId: string, quantity: number) {
  return request(app)
    .post('/stock')
    .set('Authorization', authHeader('ADMIN'))
    .send({ productId, quantity });
}

async function reserveStock(productId: string, amount: number) {
  return request(app)
    .post('/stock/reserve')
    .set('Authorization', authHeader('BUYER'))
    .send({ productId, amount });
}

describe('POST /stock (setStock) — autorizacao', () => {
  it('sem token -> 401', async () => {
    const res = await request(app).post('/stock').send({ productId: pid('a'), quantity: 10 });
    expect(res.status).toBe(401);
  });

  it('BUYER -> 403', async () => {
    const res = await request(app)
      .post('/stock')
      .set('Authorization', authHeader('BUYER'))
      .send({ productId: pid('b'), quantity: 10 });
    expect(res.status).toBe(403);
  });

  it('ADMIN define estoque -> 200', async () => {
    const res = await request(app)
      .post('/stock')
      .set('Authorization', authHeader('ADMIN'))
      .send({ productId: pid('c'), quantity: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('quantity', 10);
  });

  it('SELLER define estoque -> 200', async () => {
    const res = await request(app)
      .post('/stock')
      .set('Authorization', authHeader('SELLER'))
      .send({ productId: pid('d'), quantity: 5 });
    expect(res.status).toBe(200);
  });
});

describe('POST /stock (setStock) — validacao e conflito', () => {
  it('sem productId -> 400', async () => {
    const res = await request(app)
      .post('/stock')
      .set('Authorization', authHeader('ADMIN'))
      .send({ quantity: 10 });
    expect(res.status).toBe(400);
  });

  it('quantity negativo -> 400', async () => {
    const res = await request(app)
      .post('/stock')
      .set('Authorization', authHeader('ADMIN'))
      .send({ productId: pid('e'), quantity: -5 });
    expect(res.status).toBe(400);
  });

  it('quantity < reserved -> 409', async () => {
    const productId = pid('f');
    // Estado: 10 em estoque, reserva 6. Agora tentar setStock(4) < 6 reservados.
    await seedStock(productId, 10);
    await reserveStock(productId, 6);

    const res = await request(app)
      .post('/stock')
      .set('Authorization', authHeader('ADMIN'))
      .send({ productId, quantity: 4 });

    expect(res.status).toBe(409);
  });
});

describe('GET /stock/:productId (getAvailability) — publica', () => {
  it('produto sem estoque cadastrado -> 404', async () => {
    const res = await request(app).get(`/stock/${pid('none')}`);
    expect(res.status).toBe(404);
  });

  it('produto com estoque -> 200 e formato', async () => {
    const productId = pid('g');
    await seedStock(productId, 8);

    const res = await request(app).get(`/stock/${productId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('quantity', 8);
    expect(res.body).toHaveProperty('available');
  });
});

describe('POST /stock/reserve (reserve) — autenticado (qualquer papel)', () => {
  it('sem token -> 401', async () => {
    const res = await request(app)
      .post('/stock/reserve')
      .send({ productId: pid('h'), amount: 1 });
    expect(res.status).toBe(401);
  });

  it('BUYER logado reserva -> 200 (reserva liberada a qualquer papel, por design)', async () => {
    const productId = pid('i');
    await seedStock(productId, 10);

    const res = await request(app)
      .post('/stock/reserve')
      .set('Authorization', authHeader('BUYER'))
      .send({ productId, amount: 3 });

    expect(res.status).toBe(200);
  });

  it('payload invalido (sem amount) -> 400', async () => {
    const res = await request(app)
      .post('/stock/reserve')
      .set('Authorization', authHeader('BUYER'))
      .send({ productId: pid('j') });
    expect(res.status).toBe(400);
  });

  it('estoque insuficiente -> 409', async () => {
    const productId = pid('k');
    await seedStock(productId, 2);

    const res = await request(app)
      .post('/stock/reserve')
      .set('Authorization', authHeader('BUYER'))
      .send({ productId, amount: 5 }); // pede mais do que existe

    expect(res.status).toBe(409);
  });
});

describe('POST /stock/release (release) — ADMIN/SELLER', () => {
  it('sem token -> 401', async () => {
    const res = await request(app)
      .post('/stock/release')
      .send({ productId: pid('l'), amount: 1 });
    expect(res.status).toBe(401);
  });

  it('BUYER -> 403', async () => {
    const res = await request(app)
      .post('/stock/release')
      .set('Authorization', authHeader('BUYER'))
      .send({ productId: pid('m'), amount: 1 });
    expect(res.status).toBe(403);
  });

  it('ADMIN libera reserva -> 200', async () => {
    const productId = pid('n');
    await seedStock(productId, 10);
    await reserveStock(productId, 4);

    const res = await request(app)
      .post('/stock/release')
      .set('Authorization', authHeader('ADMIN'))
      .send({ productId, amount: 4 });

    expect(res.status).toBe(200);
  });

  it('SELLER libera reserva -> 200', async () => {
    const productId = pid('o');
    await seedStock(productId, 10);
    await reserveStock(productId, 4);

    const res = await request(app)
      .post('/stock/release')
      .set('Authorization', authHeader('SELLER'))
      .send({ productId, amount: 4 });

    expect(res.status).toBe(200);
  });

  it('liberacao invalida (reserva inexistente) -> 409', async () => {
    const productId = pid('p');
    await seedStock(productId, 10); // estoque existe, mas nada reservado

    const res = await request(app)
      .post('/stock/release')
      .set('Authorization', authHeader('ADMIN'))
      .send({ productId, amount: 5 }); // libera mais do que o reservado (0)

    expect(res.status).toBe(409);
  });
});
