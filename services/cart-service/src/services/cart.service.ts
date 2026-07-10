import { getRedisClient } from '../config/redis';
import { loadConfig } from '../config/env';

export interface CartItem {
  productId: string;
  quantity: number;
}

function cartKey(userId: string): string {
  return 'cart:' + userId;
}

async function refreshTtl(key: string): Promise<void> {
  const { cartTtlSeconds } = loadConfig();
  // EXPIRE em chave inexistente e no-op (retorna 0), entao chamar apos remocao
  // que esvaziou o carrinho e seguro.
  await getRedisClient().expire(key, cartTtlSeconds);
}

export async function getCart(userId: string): Promise<CartItem[]> {
  const hash = await getRedisClient().hgetall(cartKey(userId));
  return Object.entries(hash).map(([productId, qty]) => ({
    productId,
    quantity: Number(qty),
  }));
}

export async function addItem(
  userId: string,
  productId: string,
  quantity: number
): Promise<CartItem[]> {
  const key = cartKey(userId);
  await getRedisClient().hincrby(key, productId, quantity);
  await refreshTtl(key);
  return getCart(userId);
}

export async function updateQuantity(
  userId: string,
  productId: string,
  quantity: number
): Promise<CartItem[]> {
  const key = cartKey(userId);
  const exists = await getRedisClient().hexists(key, productId);
  if (!exists) {
    throw new Error('ITEM_NAO_ENCONTRADO');
  }
  await getRedisClient().hset(key, productId, quantity);
  await refreshTtl(key);
  return getCart(userId);
}

export async function removeItem(
  userId: string,
  productId: string
): Promise<CartItem[]> {
  const key = cartKey(userId);
  await getRedisClient().hdel(key, productId);
  // Remocao tambem e escrita: renova o TTL deslizante. No-op se esvaziou.
  await refreshTtl(key);
  return getCart(userId);
}

export async function clearCart(userId: string): Promise<void> {
  await getRedisClient().del(cartKey(userId));
}
