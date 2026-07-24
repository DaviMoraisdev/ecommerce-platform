jest.mock('../src/clients/cart.client');
jest.mock('../src/clients/inventory.client');

import { prisma } from '../src/config/database';
import { assertTestDatabase } from './helpers/testDbGuard';
import * as cartClient from '../src/clients/cart.client';
import * as inventoryClient from '../src/clients/inventory.client';
import { createOrder } from '../src/services/order.service';
import { DomainError } from '../src/domain/errors';

const mockedCart = cartClient as jest.Mocked<typeof cartClient>;
const mockedInv = inventoryClient as jest.Mocked<typeof inventoryClient>;

beforeAll(() => assertTestDatabase());
afterEach(async () => {
  await prisma.order.deleteMany();
  jest.clearAllMocks();
});
afterAll(async () => {
  await prisma.$disconnect();
});

function cart(items: any[], partial = false) {
  return { items, total: 999, partial };
}

describe('createOrder (saga)', () => {
  it('cria pedido com itens e total calculado no servidor', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([
        { productId: 'p1', quantity: 2, name: 'X', price: 10.5, subtotal: 21, available: 5 },
        { productId: 'p2', quantity: 1, name: 'Y', price: 5, subtotal: 5, available: 3 },
      ])
    );
    mockedInv.reserve.mockResolvedValue(undefined);
    mockedCart.clearCart.mockResolvedValue(undefined);

    const order = await createOrder('u1', 'Bearer tok');

    expect(order.status).toBe('PENDENTE');
    expect(Number(order.total)).toBe(26); // 21 + 5, ignorando o total do carrinho
    expect(order.items).toHaveLength(2);
    expect(mockedInv.reserve).toHaveBeenCalledTimes(2);
    expect(mockedInv.reserve).toHaveBeenCalledWith('p1', 2, order.id);
    expect(mockedCart.clearCart).toHaveBeenCalled();
  });

  it('rejeita carrinho vazio sem reservar nem criar', async () => {
    mockedCart.getCart.mockResolvedValue(cart([]));
    await expect(createOrder('u1', 'Bearer tok')).rejects.toThrow('CARRINHO_VAZIO');
    expect(mockedInv.reserve).not.toHaveBeenCalled();
    expect(await prisma.order.count()).toBe(0);
  });

  it('rejeita carrinho sem preco (partial) sem reservar', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: null, price: null, subtotal: null, available: null }], true)
    );
    await expect(createOrder('u1', 'Bearer tok')).rejects.toThrow('CARRINHO_SEM_PRECO');
    expect(mockedInv.reserve).not.toHaveBeenCalled();
  });

  it('estoque insuficiente no 2o item: compensa (release) e NAO cria pedido', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([
        { productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 5 },
        { productId: 'p2', quantity: 1, name: 'Y', price: 10, subtotal: 10, available: 0 },
      ])
    );
    mockedInv.reserve
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DomainError('ESTOQUE_INSUFICIENTE'));
    mockedInv.release.mockResolvedValue(undefined);

    await expect(createOrder('u1', 'Bearer tok')).rejects.toThrow('ESTOQUE_INSUFICIENTE');
    expect(mockedInv.release).toHaveBeenCalledTimes(1);
    expect(await prisma.order.count()).toBe(0);
  });

  it('compensacao que falha NAO mascara o erro original', async () => {
    mockedCart.getCart.mockResolvedValue(
      cart([{ productId: 'p1', quantity: 1, name: 'X', price: 10, subtotal: 10, available: 0 }])
    );
    mockedInv.reserve.mockRejectedValue(new DomainError('ESTOQUE_INSUFICIENTE'));
    mockedInv.release.mockRejectedValue(new DomainError('RELEASE_FALHOU'));

    await expect(createOrder('u1', 'Bearer tok')).rejects.toThrow('ESTOQUE_INSUFICIENTE');
    expect(await prisma.order.count()).toBe(0);
  });
});
