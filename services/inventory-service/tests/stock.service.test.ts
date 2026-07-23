import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

import { prisma } from '../src/config/database';
import {
  setStock,
  getAvailability,
  reserveStock,
  releaseByOrder,
  getReservations,
} from '../src/services/stock.service';

// Testes de INTEGRACAO: a logica vive no SQL (executeRaw atomico + transacao).
// productId unico por teste; cleanup no afterAll.
describe('stock.service - logica de estoque', () => {
  const ids: string[] = [];
  function novoId(): string {
    const id = 'test-stock-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    ids.push(id);
    return id;
  }
  function novoOrderId(): string {
    return 'order-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  }

  afterAll(async () => {
    await prisma.reservation.deleteMany({ where: { productId: { in: ids } } });
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
      await reserveStock(id, 6, novoOrderId());
      await expect(setStock(id, 3)).rejects.toThrow('QUANTITY_BELOW_RESERVED');
    });
  });

  describe('getAvailability', () => {
    it('retorna available = quantity - reserved', async () => {
      const id = novoId();
      await setStock(id, 10);
      await reserveStock(id, 3, novoOrderId());
      const av = await getAvailability(id);
      expect(av).toEqual({ productId: id, quantity: 10, reserved: 3, available: 7 });
    });
    it('retorna null para produto sem estoque cadastrado', async () => {
      const av = await getAvailability('nao-existe-' + Date.now());
      expect(av).toBeNull();
    });
  });

  describe('reserveStock', () => {
    it('reserva dentro do disponivel e cria a Reservation ACTIVE', async () => {
      const id = novoId();
      const oid = novoOrderId();
      await setStock(id, 10);
      const result = await reserveStock(id, 4, oid);
      expect(result.reserved).toBe(4);
      expect(result.available).toBe(6);
      expect(result.reservationId).toBeDefined();

      const reservas = await getReservations(oid);
      expect(reservas).toHaveLength(1);
      expect(reservas[0]).toMatchObject({
        productId: id, quantity: 4, orderId: oid, status: 'ACTIVE',
      });
    });
    it('rejeita reservar alem do disponivel (INSUFFICIENT_STOCK)', async () => {
      const id = novoId();
      await setStock(id, 5);
      await expect(reserveStock(id, 10, novoOrderId())).rejects.toThrow('INSUFFICIENT_STOCK');
    });
    it('rejeita produto inexistente (PRODUCT_NOT_FOUND)', async () => {
      await expect(reserveStock('nao-existe-' + Date.now(), 1, novoOrderId())).rejects.toThrow('PRODUCT_NOT_FOUND');
    });
    it('rejeita amount float (INVALID_AMOUNT)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await expect(reserveStock(id, 2.5, novoOrderId())).rejects.toThrow('INVALID_AMOUNT');
    });
    it('rejeita amount zero (INVALID_AMOUNT)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await expect(reserveStock(id, 0, novoOrderId())).rejects.toThrow('INVALID_AMOUNT');
    });
    it('rejeita orderId vazio (INVALID_ORDER_ID)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await expect(reserveStock(id, 3, '   ')).rejects.toThrow('INVALID_ORDER_ID');
    });
    it('falha na reserva NAO deixa estoque debitado (transacao atomica)', async () => {
      const id = novoId();
      await setStock(id, 5);
      await expect(reserveStock(id, 10, novoOrderId())).rejects.toThrow();
      const av = await getAvailability(id);
      expect(av?.reserved).toBe(0);
      expect(av?.available).toBe(5);
    });
  });

    it('idempotente: reservar o mesmo pedido+produto de novo retorna a existente', async () => {
      const id = novoId();
      const oid = novoOrderId();
      await setStock(id, 10);
      const primeira = await reserveStock(id, 3, oid);
      const segunda = await reserveStock(id, 3, oid);
      expect(segunda.reservationId).toBe(primeira.reservationId);
      const av = await getAvailability(id);
      expect(av?.reserved).toBe(3); // nao debitou 2x
      const ativas = (await getReservations(oid)).filter((r) => r.status === 'ACTIVE');
      expect(ativas).toHaveLength(1);
    });
    it('P1: retry APOS liberar rejeita e NAO re-debita (RESERVA_JA_LIBERADA)', async () => {
      const id = novoId();
      const oid = novoOrderId();
      await setStock(id, 10);
      await reserveStock(id, 3, oid);
      await releaseByOrder(oid);
      await expect(reserveStock(id, 3, oid)).rejects.toThrow('RESERVA_JA_LIBERADA');
      const av = await getAvailability(id);
      expect(av?.reserved).toBe(0); // liberado continua liberado, sem re-debito
    });
    it('P2: retry com quantidade diferente e rejeitado sem alterar (RESERVA_QUANTIDADE_DIVERGENTE)', async () => {
      const id = novoId();
      const oid = novoOrderId();
      await setStock(id, 10);
      await reserveStock(id, 3, oid);
      await expect(reserveStock(id, 5, oid)).rejects.toThrow('RESERVA_QUANTIDADE_DIVERGENTE');
      const av = await getAvailability(id);
      expect(av?.reserved).toBe(3); // mantem 3, nao vira 5 nem soma
    });

    it('rejeita amount string (INVALID_AMOUNT)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await expect(reserveStock(id, '3' as any, novoOrderId())).rejects.toThrow('INVALID_AMOUNT');
    });
    it('rejeita orderId nao-string ou longo demais (INVALID_ORDER_ID)', async () => {
      const id = novoId();
      await setStock(id, 10);
      await expect(reserveStock(id, 3, 123 as any)).rejects.toThrow('INVALID_ORDER_ID');
      await expect(reserveStock(id, 3, 'x'.repeat(200))).rejects.toThrow('INVALID_ORDER_ID');
    });
    it('normaliza orderId (trim) ao reservar', async () => {
      const id = novoId();
      const oid = novoOrderId();
      await setStock(id, 10);
      await reserveStock(id, 2, '  ' + oid + '  ');
      expect(await getReservations(oid)).toHaveLength(1);
    });

  describe('releaseByOrder', () => {
    it('libera todas as reservas do pedido e devolve o estoque', async () => {
      const id = novoId();
      const oid = novoOrderId();
      await setStock(id, 10);
      await reserveStock(id, 5, oid);
      const result = await releaseByOrder(oid);
      expect(result).toEqual({ orderId: oid, released: 1 });

      const av = await getAvailability(id);
      expect(av?.reserved).toBe(0);
      expect(av?.available).toBe(10);
      const reservas = await getReservations(oid);
      expect(reservas[0].status).toBe('RELEASED');
    });

    it('posse: release do pedido A nao toca as reservas do pedido B', async () => {
      const id = novoId();
      const orderA = novoOrderId();
      const orderB = novoOrderId();
      await setStock(id, 10);
      await reserveStock(id, 3, orderA);
      await reserveStock(id, 2, orderB);

      await releaseByOrder(orderA);

      const av = await getAvailability(id);
      expect(av?.reserved).toBe(2); // so os 2 de B seguem reservados
      expect(av?.available).toBe(8);
    });

    it('idempotente: release de pedido ja liberado retorna released 0', async () => {
      const id = novoId();
      const oid = novoOrderId();
      await setStock(id, 10);
      await reserveStock(id, 4, oid);
      await releaseByOrder(oid);
      expect(await releaseByOrder(oid)).toEqual({ orderId: oid, released: 0 });
    });

    it('release de pedido sem reservas retorna released 0 (sem erro)', async () => {
      const result = await releaseByOrder('order-inexistente-' + Date.now());
      expect(result.released).toBe(0);
    });

    it('rejeita orderId vazio (INVALID_ORDER_ID)', async () => {
      await expect(releaseByOrder('  ')).rejects.toThrow('INVALID_ORDER_ID');
    });
  });
});
