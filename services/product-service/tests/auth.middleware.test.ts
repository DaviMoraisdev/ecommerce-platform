import request from 'supertest';
import app from '../src/app';
import {
  authHeader,
  authHeaderWrongSecret,
  authHeaderExpired,
} from './helpers/auth';

jest.mock('../src/services/inventory.client', () => ({
  fetchAvailability: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/config/redis', () => require('./helpers/mockRedis').makeRedisMock());

const validProduct = {
  name: 'Produto Teste',
  description: 'desc',
  price: 50,
  category: 'geral',
};

// Usa POST /products como rota protegida representativa: ela exige
// authMiddleware + requireRole. Se o token nao passa no middleware, nem
// chega no controller — retorna 401 antes de qualquer logica de produto.
describe('authMiddleware — tokens invalidos em rota protegida', () => {
  it('header sem prefixo Bearer -> 401', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', 'token-sem-bearer')
      .send(validProduct);
    expect(res.status).toBe(401);
  });

  it('Bearer com token malformado (nao e JWT) -> 401', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', 'Bearer isto-nao-e-um-jwt')
      .send(validProduct);
    expect(res.status).toBe(401);
  });

  it('token assinado com segredo errado -> 401', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', authHeaderWrongSecret('ADMIN'))
      .send(validProduct);
    expect(res.status).toBe(401);
  });

  it('token expirado -> 401', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', authHeaderExpired('ADMIN'))
      .send(validProduct);
    expect(res.status).toBe(401);
  });

  it('token valido (controle) -> NAO retorna 401', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', authHeader('ADMIN'))
      .send(validProduct);
    // Prova que o 401 dos casos acima vem do token ruim, nao de outra causa.
    expect(res.status).not.toBe(401);
  });
});
