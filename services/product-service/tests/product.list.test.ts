import request from 'supertest';
import app from '../src/app';
import { Product } from '../src/models/product.model';

// Mesmo padrao de mock: inventory.client e redis fora do caminho.
jest.mock('../src/services/inventory.client', () => ({
  fetchAvailability: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/config/redis', () => require('./helpers/mockRedis').makeRedisMock());

// Insere N produtos de uma vez. Por padrao, todos na mesma categoria.
async function seedMany(count: number, overrides: Partial<Record<string, any>> = {}) {
  const docs = [];
  for (let i = 0; i < count; i++) {
    docs.push({
      name: `Produto ${i}`,
      description: `Descricao do produto ${i}`,
      price: 10 + i,
      category: 'geral',
      ...overrides,
    });
  }
  await Product.insertMany(docs);
}

describe('GET /products — paginacao', () => {
  it('default: page 1, limit 20, formato paginado completo', async () => {
    await seedMany(3);
    const res = await request(app).get('/products');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('page', 1);
    expect(res.body).toHaveProperty('limit', 20);
    expect(res.body).toHaveProperty('total', 3);
    expect(res.body).toHaveProperty('totalPages', 1);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(3);
  });

  it('page/limit custom: respeita o limit e calcula totalPages', async () => {
    await seedMany(5);
    const res = await request(app).get('/products?page=1&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
    expect(res.body.total).toBe(5);
    expect(res.body.totalPages).toBe(3);
    expect(res.body.data).toHaveLength(2);
  });

  it('segunda pagina retorna itens diferentes da primeira', async () => {
    await seedMany(5);
    const p1 = await request(app).get('/products?page=1&limit=2');
    const p2 = await request(app).get('/products?page=2&limit=2');

    const ids1 = p1.body.data.map((p: any) => p._id);
    const ids2 = p2.body.data.map((p: any) => p._id);
    // Nenhum id da pagina 1 aparece na pagina 2
    expect(ids2.some((id: string) => ids1.includes(id))).toBe(false);
  });

  it('limit > 50 -> 400', async () => {
    const res = await request(app).get('/products?limit=51');
    expect(res.status).toBe(400);
  });

  it('page invalido (nao-numerico) -> 400', async () => {
    const res = await request(app).get('/products?page=abc');
    expect(res.status).toBe(400);
  });

  it('limit invalido (zero) -> 400', async () => {
    const res = await request(app).get('/products?limit=0');
    expect(res.status).toBe(400);
  });
});

describe('GET /products — filtro e busca', () => {
  it('filtra por categoria', async () => {
    await seedMany(2, { category: 'eletronicos' });
    await seedMany(3, { category: 'roupas' });

    const res = await request(app).get('/products?category=eletronicos');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data.every((p: any) => p.category === 'eletronicos')).toBe(true);
  });

  it('busca por texto encontra pelo nome', async () => {
    await Product.create({
      name: 'Cadeira Ergonomica',
      description: 'Apoio lombar',
      price: 800,
      category: 'moveis',
    });
    await Product.create({
      name: 'Mesa de Jantar',
      description: 'Madeira macica',
      price: 1200,
      category: 'moveis',
    });

    const res = await request(app).get('/products?search=Cadeira');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].name).toContain('Cadeira');
  });

  it('search vazia -> 400', async () => {
    const res = await request(app).get('/products?search=');
    expect(res.status).toBe(400);
  });

  it('search muito longa (> 100 chars) -> 400', async () => {
    const longSearch = 'a'.repeat(101);
    const res = await request(app).get(`/products?search=${longSearch}`);
    expect(res.status).toBe(400);
  });
});
