jest.mock('../src/config/database', () => ({
  prisma: { $queryRaw: jest.fn() },
}));

import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/database';

const mockedQueryRaw = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw;

describe('GET /health', () => {
  it('200 e database up quando o banco responde', async () => {
    mockedQueryRaw.mockResolvedValue([{ ok: 1 }]);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'order-service',
      database: 'up',
    });
  });

  it('503 e database down quando o banco falha', async () => {
    mockedQueryRaw.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'error', database: 'down' });
  });
});
