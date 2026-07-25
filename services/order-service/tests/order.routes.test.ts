jest.mock('../src/services/order.service');

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app';
import * as orderService from '../src/services/order.service';
import { DomainError } from '../src/domain/errors';
import { prisma } from '../src/config/database';

const mocked = orderService as jest.Mocked<typeof orderService>;

function token(role: string, id = 'u1'): string {
  return 'Bearer ' + jwt.sign({ id, email: 'a@b.c', role }, process.env.JWT_SECRET as string);
}
function idem(): string {
  return 'idem-' + Math.random().toString(36).slice(2);
}

beforeEach(() => jest.clearAllMocks());
afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /orders', () => {
  it('401 sem token', async () => {
    const res = await request(app).post('/orders').set('Idempotency-Key', idem());
    expect(res.status).toBe(401);
  });
  it('400 sem Idempotency-Key', async () => {
    const res = await request(app).post('/orders').set('Authorization', token('BUYER'));
    expect(res.status).toBe(400);
  });
  it('201 cria pedido', async () => {
    mocked.createOrder.mockResolvedValue({ id: 'o1', userId: 'u1', status: 'PENDENTE' } as any);
    const res = await request(app).post('/orders').set('Authorization', token('BUYER')).set('Idempotency-Key', idem());
    expect(res.status).toBe(201);
    expect(mocked.createOrder).toHaveBeenCalled();
  });
  it('400 carrinho vazio', async () => {
    mocked.createOrder.mockRejectedValue(new DomainError('CARRINHO_VAZIO'));
    const res = await request(app).post('/orders').set('Authorization', token('BUYER')).set('Idempotency-Key', idem());
    expect(res.status).toBe(400);
  });
  it('409 estoque insuficiente', async () => {
    mocked.createOrder.mockRejectedValue(new DomainError('ESTOQUE_INSUFICIENTE'));
    const res = await request(app).post('/orders').set('Authorization', token('BUYER')).set('Idempotency-Key', idem());
    expect(res.status).toBe(409);
  });
  it('502 carrinho com resposta invalida', async () => {
    mocked.createOrder.mockRejectedValue(new DomainError('CARRINHO_INVALIDO'));
    const res = await request(app).post('/orders').set('Authorization', token('BUYER')).set('Idempotency-Key', idem());
    expect(res.status).toBe(502);
  });
  it('503 cart indisponivel', async () => {
    mocked.createOrder.mockRejectedValue(new DomainError('CART_INDISPONIVEL'));
    const res = await request(app).post('/orders').set('Authorization', token('BUYER')).set('Idempotency-Key', idem());
    expect(res.status).toBe(503);
  });
});

describe('GET /orders/:id', () => {
  it('404 quando nao existe', async () => {
    mocked.getOrderById.mockResolvedValue(null as any);
    const res = await request(app).get('/orders/x').set('Authorization', token('BUYER'));
    expect(res.status).toBe(404);
  });
  it('200 para o dono', async () => {
    mocked.getOrderById.mockResolvedValue({ id: 'o1', userId: 'u1', items: [] } as any);
    const res = await request(app).get('/orders/o1').set('Authorization', token('BUYER', 'u1'));
    expect(res.status).toBe(200);
  });
  it('404 (nao 403) para pedido de outro usuario nao-admin', async () => {
    mocked.getOrderById.mockResolvedValue({ id: 'o1', userId: 'outro', items: [] } as any);
    const res = await request(app).get('/orders/o1').set('Authorization', token('BUYER', 'u1'));
    expect(res.status).toBe(404);
  });
  it('200 para ADMIN mesmo nao sendo dono', async () => {
    mocked.getOrderById.mockResolvedValue({ id: 'o1', userId: 'outro', items: [] } as any);
    const res = await request(app).get('/orders/o1').set('Authorization', token('ADMIN', 'admin1'));
    expect(res.status).toBe(200);
  });
});

describe('PATCH /orders/:id/status', () => {
  it('403 para BUYER', async () => {
    const res = await request(app).patch('/orders/o1/status').set('Authorization', token('BUYER')).send({ status: 'PAGO' });
    expect(res.status).toBe(403);
  });
  it('400 status invalido', async () => {
    const res = await request(app).patch('/orders/o1/status').set('Authorization', token('ADMIN')).send({ status: 'XPTO' });
    expect(res.status).toBe(400);
  });
  it('200 ADMIN muda status com changedBy = userId (via changeOrderStatus)', async () => {
    mocked.changeOrderStatus.mockResolvedValue({ id: 'o1', status: 'PAGO' } as any);
    const res = await request(app).patch('/orders/o1/status').set('Authorization', token('ADMIN', 'admin1')).send({ status: 'PAGO' });
    expect(res.status).toBe(200);
    expect(mocked.changeOrderStatus).toHaveBeenCalledWith('o1', 'PAGO', 'admin1');
  });
  it('404 pedido inexistente', async () => {
    mocked.changeOrderStatus.mockRejectedValue(new DomainError('PEDIDO_NAO_ENCONTRADO'));
    const res = await request(app).patch('/orders/o1/status').set('Authorization', token('ADMIN')).send({ status: 'PAGO' });
    expect(res.status).toBe(404);
  });
  it('409 transicao invalida', async () => {
    mocked.changeOrderStatus.mockRejectedValue(new DomainError('TRANSICAO_INVALIDA'));
    const res = await request(app).patch('/orders/o1/status').set('Authorization', token('ADMIN')).send({ status: 'ENTREGUE' });
    expect(res.status).toBe(409);
  });
  it('409 conflito de concorrencia (CONFLITO_DE_ESTADO)', async () => {
    mocked.changeOrderStatus.mockRejectedValue(new DomainError('CONFLITO_DE_ESTADO'));
    const res = await request(app).patch('/orders/o1/status').set('Authorization', token('ADMIN')).send({ status: 'PAGO' });
    expect(res.status).toBe(409);
  });
});
