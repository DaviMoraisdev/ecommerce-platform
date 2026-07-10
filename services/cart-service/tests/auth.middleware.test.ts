import express, { Request, Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../src/middlewares/auth.middleware';

const SECRET = 'test_secret';

// App minimo so para exercitar o middleware numa rota protegida.
function buildApp() {
  const app = express();
  app.get('/protegido', authMiddleware, (req: Request, res: Response) => {
    res.status(200).json({
      userId: (req as any).userId,
      role: (req as any).userRole,
    });
  });
  return app;
}

describe('authMiddleware', () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD;
  });

  it('401 quando nao ha header Authorization', async () => {
    const res = await request(buildApp()).get('/protegido');
    expect(res.status).toBe(401);
  });

  it('401 quando o token e invalido', async () => {
    const res = await request(buildApp())
      .get('/protegido')
      .set('Authorization', 'Bearer token_invalido');
    expect(res.status).toBe(401);
  });

  it('passa e injeta userId/role com token valido', async () => {
    const token = jwt.sign(
      { id: 'u1', email: 'a@b.c', role: 'CUSTOMER' },
      SECRET
    );
    const res = await request(buildApp())
      .get('/protegido')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1', role: 'CUSTOMER' });
  });
});
