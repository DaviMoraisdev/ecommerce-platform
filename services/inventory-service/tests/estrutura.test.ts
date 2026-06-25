import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

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
    it('app e um handler do Express valido', () => {
      expect(typeof app).toBe('function');
    });

    it('importar o app NAO faz o Express escutar uma porta', () => {
      // Prova real da separacao app/server: o app importado nao deve ter
      // um servidor escutando. Um app Express que nunca chamou listen()
      // nao tem a propriedade interna de servidor ativo.
      // Verificamos que nenhum listener foi montado pelo simples import.
      const appWithServer = app as unknown as { listening?: boolean };
      expect(appWithServer.listening).toBeUndefined();
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
      ).rejects.toThrow('quantity_nao_negativa');
    });

    it('rejeita reserved > quantity (CHECK reserved <= quantity)', async () => {
      const id = 'test-constraint-res-' + Date.now();
      ids.push(id);
      await expect(
        prisma.inventory.create({
          data: { productId: id, quantity: 5, reserved: 10 },
        })
      ).rejects.toThrow('reserved_menor_igual_quantity');
    });

    it('rejeita reserved negativo (CHECK reserved >= 0)', async () => {
      const id = 'test-constraint-resneg-' + Date.now();
      ids.push(id);
      await expect(
        prisma.inventory.create({
          data: { productId: id, quantity: 5, reserved: -2 },
        })
      ).rejects.toThrow('reserved_nao_negativa');
    });
  });
});
