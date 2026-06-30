import request from 'supertest';
import app from '../src/app';
import { authHeader } from './helpers/auth';

// Mocka o inventory.client: nenhum teste deste arquivo depende do inventory-service.
jest.mock('../src/services/inventory.client', () => ({
  fetchAvailability: jest.fn().mockResolvedValue(null),
}));

// Mocka o redis com factory inline: um fake em memoria que responde aos comandos
// usados pelo service (get/set/incr) sem abrir conexao TCP. Evita tanto o
// "[redis] erro de conexao" quanto o "[cache] invalidacao falhou", porque agora
// o incr realmente funciona em vez de lancar.
jest.mock('../src/config/redis', () => {
  const store: Record<string, string> = {};
  const fakeClient = {
    get: jest.fn(async (key: string) => store[key] ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store[key] = value;
      return 'OK';
    }),
    incr: jest.fn(async (key: string) => {
      const next = parseInt(store[key] ?? '0', 10) + 1;
      store[key] = String(next);
      return next;
    }),
  };
  return { getRedisClient: () => fakeClient };
});

const validProduct = {
  name: 'Teclado Mecanico',
  description: 'Switch marrom, ABNT2',
  price: 350,
  category: 'perifericos',
};

describe('POST /products — autorizacao', () => {
  it('ADMIN cria produto -> 201', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', authHeader('ADMIN'))
      .send(validProduct);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('_id');
    expect(res.body.name).toBe(validProduct.name);
  });

  it('SELLER cria produto -> 201', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', authHeader('SELLER'))
      .send(validProduct);

    expect(res.status).toBe(201);
  });

  it('sem token -> 401', async () => {
    const res = await request(app).post('/products').send(validProduct);
    expect(res.status).toBe(401);
  });

  it('BUYER -> 403', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', authHeader('BUYER'))
      .send(validProduct);

    expect(res.status).toBe(403);
  });
});

describe('POST /products — validacao', () => {
  it('campos obrigatorios faltando -> 400', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', authHeader('ADMIN'))
      .send({ name: 'So o nome' });

    expect(res.status).toBe(400);
  });

  it('preco negativo -> 400', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', authHeader('ADMIN'))
      .send({ ...validProduct, price: -10 });

    expect(res.status).toBe(400);
  });
});
