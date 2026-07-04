import request from 'supertest';
import app from '../src/app';
import { authHeader } from './helpers/auth';

// Testa rotas HTTP do stock: status (400/401/403/404/409) e autorizacao.
// App via Supertest (sem subir servidor). Banco: inventory_test_db isolado.
// REQUER Docker/Postgres ativo. Tokens: JWT reais do .env.test.

function pid(suffix: string): string {
  return `prod-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Helpers de setup que AFIRMAM sucesso: se o setup falhar, o erro aparece aqui
// (diagnostico claro), nao la na frente numa assercao menos obvia.
async function seedStockOk(productId: string, quantity: number) {
  const res = await request(app)
    .post('/stock')
    .set('Authorization', authHeader('ADMIN'))
    .send({ productId, quantity });
  expect(res.status).toBe(200);
  return res;
}

async function reserveStockOk(productId: string, amount: number) {
  const res = await request(app)
    .post('/stock/reserve')
    .set('Authorization', authHeader('BUYER'))
    .send({ productId, amount });
  expect(res.status).toBe(200);
  return res;
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
    await seedStockOk(productId, 10);
    await reserveStockOk(productId, 6);

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
    await seedStockOk(productId, 8);

    const res = await request(app).get(`/stock/${productId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('quantity', 8);
    expect(res.body).toHaveProperty('available');
  });
});

describe('POST /stock/reserve (reserve) — autenticado (qualquer papel logado)', () => {
  it('sem token -> 401', async () => {
    const res = await request(app)
      .post('/stock/reserve')
      .send({ productId: pid('h'), amount: 1 });
    expect(res.status).toBe(401);
  });

  // Contrato documentado: QUALQUER papel logado reserva. Parametrizado para
  // provar isso de verdade — nao so BUYER (senao uma regressao que restringisse
  // a BUYER passaria despercebida).
  it.each(['ADMIN', 'SELLER', 'BUYER'] as const)(
    '%s logado reserva -> 200 e reduz o disponivel',
    async (role) => {
      const productId = pid(`res-${role}`);
      await seedStockOk(productId, 10);

      const res = await request(app)
        .post('/stock/reserve')
        .set('Authorization', authHeader(role))
        .send({ productId, amount: 3 });

      expect(res.status).toBe(200);

      // Valida o ESTADO, nao so o status: available caiu de 10 para 7.
      const check = await request(app).get(`/stock/${productId}`);
      expect(check.body.available).toBe(7);
      expect(check.body.reserved).toBe(3);
    }
  );

  it('payload invalido (sem amount) -> 400', async () => {
    const res = await request(app)
      .post('/stock/reserve')
      .set('Authorization', authHeader('BUYER'))
      .send({ productId: pid('j') });
    expect(res.status).toBe(400);
  });

  it('estoque insuficiente -> 409', async () => {
    const productId = pid('k');
    await seedStockOk(productId, 2);

    const res = await request(app)
      .post('/stock/reserve')
      .set('Authorization', authHeader('BUYER'))
      .send({ productId, amount: 5 });

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

  it('payload invalido (sem amount) -> 400', async () => {
    const res = await request(app)
      .post('/stock/release')
      .set('Authorization', authHeader('ADMIN'))
      .send({ productId: pid('inv') });
    expect(res.status).toBe(400);
  });

  it('ADMIN libera reserva -> 200 e devolve ao disponivel', async () => {
    const productId = pid('n');
    await seedStockOk(productId, 10);
    await reserveStockOk(productId, 4); // available 6, reserved 4

    const res = await request(app)
      .post('/stock/release')
      .set('Authorization', authHeader('ADMIN'))
      .send({ productId, amount: 4 });

    expect(res.status).toBe(200);

    // Estado: liberacao devolveu ao disponivel (available 10, reserved 0).
    const check = await request(app).get(`/stock/${productId}`);
    expect(check.body.available).toBe(10);
    expect(check.body.reserved).toBe(0);
  });

  it('SELLER libera reserva -> 200', async () => {
    const productId = pid('o');
    await seedStockOk(productId, 10);
    await reserveStockOk(productId, 4);

    const res = await request(app)
      .post('/stock/release')
      .set('Authorization', authHeader('SELLER'))
      .send({ productId, amount: 4 });

    expect(res.status).toBe(200);
  });

  it('liberacao invalida (reserva inexistente) -> 409', async () => {
    const productId = pid('p');
    await seedStockOk(productId, 10);

    const res = await request(app)
      .post('/stock/release')
      .set('Authorization', authHeader('ADMIN'))
      .send({ productId, amount: 5 });

    expect(res.status).toBe(409);
  });
});
