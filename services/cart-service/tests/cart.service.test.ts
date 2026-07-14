import { getRedisClient } from '../src/config/redis';
import { fetchProduct } from '../src/services/product.client';
import { createMockRedis } from './helpers/mockRedisHash';
import * as cartService from '../src/services/cart.service';

jest.mock('../src/config/redis');
jest.mock('../src/services/product.client');
const mockedGetRedisClient = jest.mocked(getRedisClient);
const mockedFetchProduct = jest.mocked(fetchProduct);

function okProduct(available: number | null) {
  return {
    status: 'ok' as const,
    product: {
      id: 'p1',
      name: 'Produto',
      price: 10,
      availability:
        available === null ? null : { available, inStock: available > 0 },
    },
  };
}

describe('cart.service', () => {
  let mock: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mock = createMockRedis();
    mockedGetRedisClient.mockReturnValue(mock.client as any);
    // Default: produto existe com estoque generoso.
    mockedFetchProduct.mockResolvedValue(okProduct(1000));
  });

  it('getCart retorna vazio quando nao ha carrinho', async () => {
    expect(await cartService.getCart('u1')).toEqual([]);
  });

  it('addItem soma quantidade atomicamente', async () => {
    await cartService.addItem('u1', 'p1', 2);
    const cart = await cartService.addItem('u1', 'p1', 3);
    expect(cart).toEqual([{ productId: 'p1', quantity: 5 }]);
  });

  it('addItem rejeita quando o produto nao existe', async () => {
    mockedFetchProduct.mockResolvedValue({ status: 'not_found' });
    await expect(cartService.addItem('u1', 'p1', 1)).rejects.toThrow(
      'PRODUTO_NAO_ENCONTRADO'
    );
  });

  it('addItem rejeita quando o product-service esta indisponivel', async () => {
    mockedFetchProduct.mockResolvedValue({ status: 'unavailable' });
    await expect(cartService.addItem('u1', 'p1', 1)).rejects.toThrow(
      'PRODUTO_SERVICE_INDISPONIVEL'
    );
  });

  it('addItem rejeita quando o estoque e insuficiente', async () => {
    mockedFetchProduct.mockResolvedValue(okProduct(3));
    await expect(cartService.addItem('u1', 'p1', 5)).rejects.toThrow(
      'ESTOQUE_INSUFICIENTE'
    );
  });

  it('addItem considera a quantidade ja no carrinho no limite de estoque', async () => {
    mockedFetchProduct.mockResolvedValue(okProduct(5));
    await cartService.addItem('u1', 'p1', 3);
    // ja tem 3; somar 3 -> 6 > 5 -> rejeita
    await expect(cartService.addItem('u1', 'p1', 3)).rejects.toThrow(
      'ESTOQUE_INSUFICIENTE'
    );
  });

  it('addItem degrada (permite) quando availability e null (inventory fora)', async () => {
    mockedFetchProduct.mockResolvedValue(okProduct(null));
    const cart = await cartService.addItem('u1', 'p1', 999);
    expect(cart).toEqual([{ productId: 'p1', quantity: 999 }]);
  });

  it('addItem renova o TTL (mecanismo)', async () => {
    const expireSpy = jest.spyOn(mock.client, 'expire');
    await cartService.addItem('u1', 'p1', 1);
    expect(expireSpy).toHaveBeenCalledWith('cart:u1', 604800);
  });

  it('updateQuantity define valor absoluto', async () => {
    await cartService.addItem('u1', 'p1', 2);
    const cart = await cartService.updateQuantity('u1', 'p1', 10);
    expect(cart).toEqual([{ productId: 'p1', quantity: 10 }]);
  });

  it('updateQuantity lanca erro se o item nao existe no carrinho', async () => {
    await expect(
      cartService.updateQuantity('u1', 'inexistente', 5)
    ).rejects.toThrow('ITEM_NAO_ENCONTRADO');
  });

  it('updateQuantity rejeita se exceder o estoque', async () => {
    mockedFetchProduct.mockResolvedValue(okProduct(4));
    await cartService.addItem('u1', 'p1', 1);
    await expect(cartService.updateQuantity('u1', 'p1', 10)).rejects.toThrow(
      'ESTOQUE_INSUFICIENTE'
    );
  });

  it('removeItem remove so o item alvo', async () => {
    await cartService.addItem('u1', 'p1', 2);
    await cartService.addItem('u1', 'p2', 1);
    const cart = await cartService.removeItem('u1', 'p1');
    expect(cart).toEqual([{ productId: 'p2', quantity: 1 }]);
  });

  it('removeItem renova o TTL do carrinho', async () => {
    await cartService.addItem('u1', 'p1', 2);
    const expireSpy = jest.spyOn(mock.client, 'expire');
    await cartService.removeItem('u1', 'p1');
    expect(expireSpy).toHaveBeenCalledWith('cart:u1', 604800);
  });

  it('getCartDetailed enriquece com nome, preco, subtotal e total', async () => {
    await cartService.addItem('u1', 'p1', 2);
    const cart = await cartService.getCartDetailed('u1');
    expect(cart.items).toEqual([
      {
        productId: 'p1',
        quantity: 2,
        name: 'Produto',
        price: 10,
        subtotal: 20,
        available: 1000,
      },
    ]);
    expect(cart.total).toBe(20);
  });

  it('getCartDetailed degrada item quando o produto some (campos null)', async () => {
    await cartService.addItem('u1', 'p1', 2);
    mockedFetchProduct.mockResolvedValue({ status: 'not_found' });
    const cart = await cartService.getCartDetailed('u1');
    expect(cart.items[0]).toEqual({
      productId: 'p1',
      quantity: 2,
      name: null,
      price: null,
      subtotal: null,
      available: null,
    });
    expect(cart.total).toBe(0);
  });

  it('getCartDetailed marca partial=true quando um item nao precifica', async () => {
    await cartService.addItem('u1', 'p1', 2);
    mockedFetchProduct.mockResolvedValue({ status: 'unavailable' });
    const cart = await cartService.getCartDetailed('u1');
    expect(cart.partial).toBe(true);
    expect(cart.total).toBe(0);
  });

  it('getCartDetailed marca partial=false quando tudo precifica', async () => {
    await cartService.addItem('u1', 'p1', 2);
    const cart = await cartService.getCartDetailed('u1');
    expect(cart.partial).toBe(false);
  });

  it('clearCart esvazia o carrinho', async () => {
    await cartService.addItem('u1', 'p1', 2);
    await cartService.clearCart('u1');
    expect(await cartService.getCart('u1')).toEqual([]);
  });
});
