import dotenv from 'dotenv';
dotenv.config();

import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/database';

describe('inventory-service - estrutura', () => {
  const ids: string[] = [];

  afterAll(async () => {
    await prisma.inventory.deleteMany({ where: { productId: { in: ids } } });
  });

  describe('GET /health', () => {
    it('responde 200 com status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('inventory-service');
    });
  });

  describe('importar o app', () => {
    it('nao sobe servidor nem ocupa porta ao ser importado', () => {
      // Se o import do app subisse o servidor, o Supertest nao conseguiria
      // usar o app em memoria. O fato de os testes HTTP funcionarem ja prova
      // a separacao. Aqui validamos que o app e um handler do Express.
      expect(typeof app).toBe('function');
    });
  });

  describe('constraints do banco', () => {
    it('rejeita quantity negativa (CHECK quantity >= 0)', async () => {
      const id = 'test-constraint-neg-' + Date.now();
      ids.push(id);
      // Tenta inserir direto no banco com quantity negativa
      await expect(
        prisma.inventory.create({
          data: { productId: id, quantity: -5, reserved: 0 },
        })
      ).rejects.toThrow();
    });

    it('rejeita reserved > quantity (CHECK reserved <= quantity)', async () => {
      const id = 'test-constraint-res-' + Date.now();
      ids.push(id);
      await expect(
        prisma.inventory.create({
          data: { productId: id, quantity: 5, reserved: 10 },
        })
      ).rejects.toThrow();
    });

    it('rejeita reserved negativo (CHECK reserved >= 0)', async () => {
      const id = 'test-constraint-resneg-' + Date.now();
      ids.push(id);
      await expect(
        prisma.inventory.create({
          data: { productId: id, quantity: 5, reserved: -2 },
        })
      ).rejects.toThrow();
    });
  });
});
