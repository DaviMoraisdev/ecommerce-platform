import request from 'supertest';
import app from '../src/app';
import { getRedisClient } from '../src/config/redis';

jest.mock('../src/config/redis');

const mockedGetRedisClient = jest.mocked(getRedisClient);

describe('GET /health', () => {
  it('retorna 200 e redis "up" quando o Redis responde PONG', async () => {
    mockedGetRedisClient.mockReturnValue({
      ping: jest.fn().mockResolvedValue('PONG'),
    } as any);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'cart-service',
      redis: 'up',
    });
  });

  it('retorna 503 e redis "down" quando o ping falha', async () => {
    mockedGetRedisClient.mockReturnValue({
      ping: jest.fn().mockRejectedValue(new Error('conexao recusada')),
    } as any);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'error',
      service: 'cart-service',
      redis: 'down',
    });
  });

  it('retorna 503 quando o ping responde algo diferente de PONG', async () => {
    mockedGetRedisClient.mockReturnValue({
      ping: jest.fn().mockResolvedValue('ALGO_ERRADO'),
    } as any);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'error',
      service: 'cart-service',
      redis: 'down',
    });
  });
});
