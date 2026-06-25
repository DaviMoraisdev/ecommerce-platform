import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

import { prisma } from '../src/config/database';
import {
  setStock,
  getAvailability,
  reserveStock,
  releaseStock,
} from '../src/services/stock.service';

// Testes de INTEGRACAO: a logica de estoque vive no SQL (executeRaw atomico),
// entao usamos o banco real. Cada teste usa um productId unico e limpa depois.
describe('stock.service - logica de estoque', () => {
  const ids: string[] = [];

  function novoId(): string {
    const id = 'test-stock-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    ids.push(id);
    return id;
  }

  afterAll(async () => {
    // Limpa os registros criados; o disconnect fica no globalTeardown
    await prisma.inventory.deleteMany({ where: { productId: { in: ids } } });
  });

  describe('setStock', () => {
    it('cria estoque novo com a quantidade informada', async () => {
      const id = novoId();
      const result = await setStock(id, 10);
      expect(result.quantity).toBe(10);
      expect(result.reserved).toBe(0);
    });

    it('atualiza a quantidade de estoque existente', async () => {
      const id = novoId();
      await setStock(id, 5);
      const updated = await setStock(id, 20);
      expect(updated.quantity).toBe(20);
    });

    it('rejeita quantity negativa com INVALID_QUANTITY', async () => {
      const id = novoId();
      await expect(setStock(id, -5)).rejects.toThrow('INVALID_QUANTITY');
    });

    it('rejeita quantity nao-inteira com INVALID_QUANTITY', async () => {
      const id = novoId();
      await expect(setStock(id, 2.5)).rejects.toThrow('INVALID_QUANTITY');
    });

    it('rejeita reduzir quantity abaixo do reservado (QUANTITY_BELOW_RESERVED)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await reserveStock(id, 6);
      // Tentar reduzir para 3, abaixo dos 6 reservados
      await expect(setStock(id, 3)).rejects.toThrow('QUANTITY_BELOW_RESERVED');
    });
  });

  describe('getAvailability', () => {
    it('retorna available = quantity - reserved', async () => {
      const id = novoId();
      await setStock(id, 10);
      await reserveStock(id, 3);
      const av = await getAvailability(id);
      expect(av).toEqual({
        productId: id,
        quantity: 10,
        reserved: 3,
        available: 7,
      });
    });

    it('retorna null para produto sem estoque cadastrado', async () => {
      const av = await getAvailability('nao-existe-' + Date.now());
      expect(av).toBeNull();
    });
  });

  describe('reserveStock', () => {
    it('reserva dentro do disponivel', async () => {
      const id = novoId();
      await setStock(id, 10);
      const result = await reserveStock(id, 4);
      expect(result?.reserved).toBe(4);
      expect(result?.available).toBe(6);
    });

    it('rejeita reservar alem do disponivel (INSUFFICIENT_STOCK)', async () => {
      const id = novoId();
      await setStock(id, 5);
      await expect(reserveStock(id, 10)).rejects.toThrow('INSUFFICIENT_STOCK');
    });

    it('rejeita produto inexistente (PRODUCT_NOT_FOUND)', async () => {
      await expect(reserveStock('nao-existe-' + Date.now(), 1)).rejects.toThrow('PRODUCT_NOT_FOUND');
    });

    it('rejeita amount float (INVALID_AMOUNT)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await expect(reserveStock(id, 2.5)).rejects.toThrow('INVALID_AMOUNT');
    });

    it('rejeita amount zero (INVALID_AMOUNT)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await expect(reserveStock(id, 0)).rejects.toThrow('INVALID_AMOUNT');
    });

    it('rejeita amount string (INVALID_AMOUNT)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await expect(reserveStock(id, '3' as any)).rejects.toThrow('INVALID_AMOUNT');
    });
  });

  describe('releaseStock', () => {
    it('libera estoque reservado', async () => {
      const id = novoId();
      await setStock(id, 10);
      await reserveStock(id, 5);
      const result = await releaseStock(id, 2);
      expect(result?.reserved).toBe(3);
      expect(result?.available).toBe(7);
    });

    it('rejeita liberar mais do que esta reservado (INVALID_RELEASE)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await reserveStock(id, 2);
      await expect(releaseStock(id, 5)).rejects.toThrow('INVALID_RELEASE');
    });
  });
});
