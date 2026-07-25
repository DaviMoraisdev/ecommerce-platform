jest.mock('../src/clients/cart.client');
jest.mock('../src/clients/inventory.client');

import { OrderStatus } from '@prisma/client';
import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';
import * as cartClient from '../src/clients/cart.client';
import * as inventoryClient from '../src/clients/inventory.client';
import { createOrder, changeOrderStatus } from '../src/services/order.service';
import { DomainError } from '../src/domain/errors';

const mockedCart = cartClient as jest.Mocked<typeof cartClient>;
const mockedInv = inventoryClient as jest.Mocked<typeof inventoryClient>;

beforeAll(() => assertTestDatabase());
afterEach(async () => {
  await prisma.idempotencyRecord.deleteMany();
  await prisma.pendingCompensation.deleteMany();
  await prisma.order.deleteMany();
  jest.clearAllMocks();
});
afterAll(async () => {
  await prisma.$disconnect();
});

function cart(items: any[], partial = false) {
  return { items, total: 999, partial };
}
function key(): string {
  return 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

describe('createOrder (saga)', () => {
  it('cria pedido com total calculado no servidor', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([
        { productId: 'p1', quantity: 2, name: 'X', price: 10.5, subtotal: 21, available: 5 },
        { productId: 'p2', quantity: 1, name: 'Y', price: 5, subtotal: 5, available: 3 },
      ])
    );
    mockedInv.reserve.mockResolvedValue(undefined);
    mockedCart.removeItem.mockResolvedValue(undefined);

    const order = await createOrder('u1', 'Bearer tok', key());
    expect(order.status).toBe('PENDENTE');
    expect(Number(order.total)).toBe(26);
    expect(order.items).toHaveLength(2);
    expect(mockedInv.reserve).toHaveBeenCalledTimes(2);
    expect(mockedCart.removeItem).toHaveBeenCalledTimes(2);
  });

  it('idempotente: mesma chave retorna o pedido e nao reserva de novo', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 5 }])
    );
    mockedInv.reserve.mockResolvedValue(undefined);
    mockedCart.removeItem.mockResolvedValue(undefined);
    const k = key();
    const a = await createOrder('u1', 'Bearer tok', k);
    const b = await createOrder('u1', 'Bearer tok', k);
    expect(b.id).toBe(a.id);
    expect(mockedInv.reserve).toHaveBeenCalledTimes(1);
  });

  it('concorrente: mesma chave nao reserva duas vezes (claim atomico)', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 5 }])
    );
    mockedInv.reserve.mockResolvedValue(undefined);
    mockedInv.release.mockResolvedValue(undefined);
    mockedCart.removeItem.mockResolvedValue(undefined);
    const k = key();
    await Promise.allSettled([
      createOrder('u1', 'Bearer tok', k),
      createOrder('u1', 'Bearer tok', k),
    ]);
    // So o vencedor reservou; o perdedor foi barrado no claim atomico.
    expect(mockedInv.reserve).toHaveBeenCalledTimes(1);
    expect(await prisma.order.count()).toBe(1);
  });

  it('PROCESSING existente (concorrente) -> IDEMPOTENCIA_EM_ANDAMENTO sem reservar', async () => {
    const k = key();
    // Simula um checkout EM ANDAMENTO (registro PROCESSING ja gravado).
    await prisma.idempotencyRecord.create({
      data: { userId: 'u1', key: k, orderId: 'oid-em-andamento', status: 'PROCESSING' },
    });
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 5 }])
    );
    await expect(createOrder('u1', 'Bearer tok', k)).rejects.toThrow('IDEMPOTENCIA_EM_ANDAMENTO');
    expect(mockedInv.reserve).not.toHaveBeenCalled();
  });

  it('mesma chave por usuarios diferentes: pedidos separados, sem vazamento', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 5 }])
    );
    mockedInv.reserve.mockResolvedValue(undefined);
    mockedCart.removeItem.mockResolvedValue(undefined);
    const k = 'shared-' + Date.now();
    const oA = await createOrder('userA', 'Bearer tokA', k);
    const oB = await createOrder('userB', 'Bearer tokB', k);
    expect(oA.id).not.toBe(oB.id);
    expect(oA.userId).toBe('userA');
    expect(oB.userId).toBe('userB');
  });

  it('retry de checkout que falhou -> CHECKOUT_JA_FALHOU', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 0 }])
    );
    mockedInv.reserve.mockRejectedValue(new DomainError('ESTOQUE_INSUFICIENTE'));
    mockedInv.release.mockResolvedValue(undefined);
    const k = key();
    await expect(createOrder('u1', 'Bearer tok', k)).rejects.toThrow('ESTOQUE_INSUFICIENTE');
    await expect(createOrder('u1', 'Bearer tok', k)).rejects.toThrow('CHECKOUT_JA_FALHOU');
  });

  it('rejeita carrinho vazio sem reservar', async () => {
    mockedCart.getCart.mockResolvedValue(cart([]));
    await expect(createOrder('u1', 'Bearer tok', key())).rejects.toThrow('CARRINHO_VAZIO');
    expect(mockedInv.reserve).not.toHaveBeenCalled();
  });

  it('rejeita carrinho sem preco (partial)', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: null, price: null, subtotal: null, available: null }], true)
    );
    await expect(createOrder('u1', 'Bearer tok', key())).rejects.toThrow('CARRINHO_SEM_PRECO');
  });

  it('rejeita item estruturalmente invalido (CARRINHO_INVALIDO) sem reservar', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: -1, name: 'X', price: 10, subtotal: 0, available: 5 }])
    );
    await expect(createOrder('u1', 'Bearer tok', key())).rejects.toThrow('CARRINHO_INVALIDO');
    expect(mockedInv.reserve).not.toHaveBeenCalled();
  });

  it('estoque insuficiente no 2o item: compensa e NAO cria pedido', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([
        { productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 5 },
        { productId: 'p2', quantity: 1, name: 'Y', price: 10, subtotal: 10, available: 0 },
      ])
    );
    mockedInv.reserve.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DomainError('ESTOQUE_INSUFICIENTE'));
    mockedInv.release.mockResolvedValue(undefined);
    await expect(createOrder('u1', 'Bearer tok', key())).rejects.toThrow('ESTOQUE_INSUFICIENTE');
    expect(mockedInv.release).toHaveBeenCalledTimes(1);
    expect(await prisma.order.count()).toBe(0);
  });

  it('compensacao que falha NAO mascara o erro E registra pendencia duravel', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 0 }])
    );
    mockedInv.reserve.mockRejectedValue(new DomainError('ESTOQUE_INSUFICIENTE'));
    mockedInv.release.mockRejectedValue(new DomainError('RELEASE_FALHOU'));
    await expect(createOrder('u1', 'Bearer tok', key())).rejects.toThrow('ESTOQUE_INSUFICIENTE');
    const pend = await prisma.pendingCompensation.findMany();
    expect(pend.length).toBeGreaterThanOrEqual(1);
  });
});

describe('changeOrderStatus', () => {
  it('cancelar libera as reservas (release chamado)', async () => {
    const order = await prisma.order.create({
      data: { userId: 'u1', status: 'PENDENTE', total: '10', idempotencyKey: key() },
    });
    mockedInv.release.mockResolvedValue(undefined);
    await changeOrderStatus(order.id, OrderStatus.CANCELADO, 'admin1');
    expect(mockedInv.release).toHaveBeenCalledWith(order.id);
  });

  it('cancelamento com release falho registra pendencia duravel', async () => {
    const order = await prisma.order.create({
      data: { userId: 'u1', status: 'PENDENTE', total: '10', idempotencyKey: key() },
    });
    mockedInv.release.mockRejectedValue(new DomainError('RELEASE_FALHOU'));
    await changeOrderStatus(order.id, OrderStatus.CANCELADO, 'admin1');
    const pend = await prisma.pendingCompensation.findMany({ where: { orderId: order.id } });
    expect(pend.length).toBe(1);
  });
});
