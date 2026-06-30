import request from 'supertest';
import app from '../src/app';
import { authHeader } from './helpers/auth';
import { Product } from '../src/models/product.model';

// Mesmo padrao de mock do B1: inventory.client e redis fora do caminho.
jest.mock('../src/services/inventory.client', () => ({
  fetchAvailability: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/config/redis', () => require('./helpers/mockRedis').makeRedisMock());

// Cria um produto direto no banco (via Mongoose, sem passar pela API).
// Usado para montar o estado inicial dos testes de update/delete/get.
async function seedProduct() {
  return Product.create({
    name: 'Mouse Gamer',
    description: 'RGB, 16000 DPI',
    price: 200,
    category: 'perifericos',
  });
}

// _id valido em formato mas inexistente no banco (24 hex chars).
const MISSING_ID = '0123456789abcdef01234567';

describe('PUT /products/:id', () => {
  it('ADMIN atualiza produto -> 200 e dado alterado', async () => {
    const product = await seedProduct();
    const res = await request(app)
      .put(`/products/${product._id}`)
      .set('Authorization', authHeader('ADMIN'))
      .send({ price: 300 });

    expect(res.status).toBe(200);
    expect(res.body.price).toBe(300);
  });

  it('SELLER atualiza produto -> 200', async () => {
    const product = await seedProduct();
    const res = await request(app)
      .put(`/products/${product._id}`)
      .set('Authorization', authHeader('SELLER'))
      .send({ price: 300 });

    expect(res.status).toBe(200);
    expect(res.body.price).toBe(300);
  });

  it('NAO altera o campo active mesmo se enviado', async () => {
    const product = await seedProduct();
    const res = await request(app)
      .put(`/products/${product._id}`)
      .set('Authorization', authHeader('ADMIN'))
      .send({ active: false, price: 199 });

    expect(res.status).toBe(200);
    // price (campo permitido) mudou; active (fora da allowlist) permanece true
    expect(res.body.price).toBe(199);
    expect(res.body.active).toBe(true);
  });

  it('preco negativo -> 400', async () => {
    const product = await seedProduct();
    const res = await request(app)
      .put(`/products/${product._id}`)
      .set('Authorization', authHeader('ADMIN'))
      .send({ price: -5 });

    expect(res.status).toBe(400);
  });

  it('produto ausente -> 404', async () => {
    const res = await request(app)
      .put(`/products/${MISSING_ID}`)
      .set('Authorization', authHeader('ADMIN'))
      .send({ price: 250 });

    expect(res.status).toBe(404);
  });

  it('sem token -> 401', async () => {
    const product = await seedProduct();
    const res = await request(app).put(`/products/${product._id}`).send({ price: 250 });
    expect(res.status).toBe(401);
  });

  it('BUYER -> 403', async () => {
    const product = await seedProduct();
    const res = await request(app)
      .put(`/products/${product._id}`)
      .set('Authorization', authHeader('BUYER'))
      .send({ price: 250 });

    expect(res.status).toBe(403);
  });
});

describe('DELETE /products/:id (soft delete)', () => {
  it('ADMIN deleta -> produto some da listagem E do detalhe', async () => {
    const product = await seedProduct();

    const del = await request(app)
      .delete(`/products/${product._id}`)
      .set('Authorization', authHeader('ADMIN'));
    expect(del.status).toBe(200);

    // Some do detalhe: GET /:id -> 404
    const detail = await request(app).get(`/products/${product._id}`);
    expect(detail.status).toBe(404);

    // Some da listagem: nao aparece em GET /products
    const list = await request(app).get('/products');
    expect(list.status).toBe(200);
    const ids = list.body.data.map((p: any) => p._id);
    expect(ids).not.toContain(String(product._id));
  });

  it('SELLER deleta produto -> 200', async () => {
    const product = await seedProduct();
    const res = await request(app)
      .delete(`/products/${product._id}`)
      .set('Authorization', authHeader('SELLER'));

    expect(res.status).toBe(200);
  });

  it('produto ausente -> 404', async () => {
    const res = await request(app)
      .delete(`/products/${MISSING_ID}`)
      .set('Authorization', authHeader('ADMIN'));
    expect(res.status).toBe(404);
  });

  it('BUYER -> 403', async () => {
    const product = await seedProduct();
    const res = await request(app)
      .delete(`/products/${product._id}`)
      .set('Authorization', authHeader('BUYER'));
    expect(res.status).toBe(403);
  });
});

describe('GET /products/:id', () => {
  it('ID malformado -> 400', async () => {
    const res = await request(app).get('/products/id-invalido');
    expect(res.status).toBe(400);
  });

  it('produto ausente -> 404', async () => {
    const res = await request(app).get(`/products/${MISSING_ID}`);
    expect(res.status).toBe(404);
  });
});
