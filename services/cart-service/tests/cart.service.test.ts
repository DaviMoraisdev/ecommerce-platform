import { getRedisClient } from '../src/config/redis';
import { createMockRedis } from './helpers/mockRedisHash';
import * as cartService from '../src/services/cart.service';

jest.mock('../src/config/redis');
const mockedGetRedisClient = jest.mocked(getRedisClient);

describe('cart.service', () => {
  let mock: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mock = createMockRedis();
    mockedGetRedisClient.mockReturnValue(mock.client as any);
  });

  it('getCart retorna vazio quando nao ha carrinho', async () => {
    expect(await cartService.getCart('u1')).toEqual([]);
  });

  it('addItem soma quantidade atomicamente', async () => {
    await cartService.addItem('u1', 'p1', 2);
    const cart = await cartService.addItem('u1', 'p1', 3);
    expect(cart).toEqual([{ productId: 'p1', quantity: 5 }]);
  });

  it('updateQuantity define valor absoluto', async () => {
    await cartService.addItem('u1', 'p1', 2);
    const cart = await cartService.updateQuantity('u1', 'p1', 10);
    expect(cart).toEqual([{ productId: 'p1', quantity: 10 }]);
  });

  it('updateQuantity lanca erro se o item nao existe', async () => {
    await expect(
      cartService.updateQuantity('u1', 'inexistente', 5)
    ).rejects.toThrow('ITEM_NAO_ENCONTRADO');
  });

  it('removeItem remove so o item alvo', async () => {
    await cartService.addItem('u1', 'p1', 2);
    await cartService.addItem('u1', 'p2', 1);
    const cart = await cartService.removeItem('u1', 'p1');
    expect(cart).toEqual([{ productId: 'p2', quantity: 1 }]);
  });

  it('removeItem renova o TTL do carrinho', async () => {
    await cartService.addItem('u1', 'p1', 2);
    await cartService.addItem('u1', 'p2', 1);
    const expireSpy = jest.spyOn(mock.client, 'expire');
    await cartService.removeItem('u1', 'p1');
    expect(expireSpy).toHaveBeenCalledWith('cart:u1', 604800);
  });

  it('clearCart esvazia o carrinho', async () => {
    await cartService.addItem('u1', 'p1', 2);
    await cartService.clearCart('u1');
    expect(await cartService.getCart('u1')).toEqual([]);
  });

  it('addItem renova o TTL (mecanismo, nao so efeito)', async () => {
    const expireSpy = jest.spyOn(mock.client, 'expire');
    await cartService.addItem('u1', 'p1', 1);
    expect(expireSpy).toHaveBeenCalledWith('cart:u1', 604800);
  });
});
