import { getRedisClient } from '../config/redis';
import { loadConfig } from '../config/env';

export interface CartItem {
  productId: string;
  quantity: number;
}

function cartKey(userId: string): string {
  return 'cart:' + userId;
}

// Renova a expiracao a cada escrita (TTL deslizante).
async function refreshTtl(key: string): Promise<void> {
  const { cartTtlSeconds } = loadConfig();
  await getRedisClient().expire(key, cartTtlSeconds);
}

export async function getCart(userId: string): Promise<CartItem[]> {
  const hash = await getRedisClient().hgetall(cartKey(userId));
  return Object.entries(hash).map(([productId, qty]) => ({
    productId,
    quantity: Number(qty),
  }));
}

// Soma quantidade de forma ATOMICA (HINCRBY). Cria o item se nao existir.
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

// Define quantidade ABSOLUTA. Exige que o item ja exista (semantica PATCH).
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

// Remove um item. Idempotente: nao falha se o item ja nao estiver la.
export async function removeItem(
  userId: string,
  productId: string
): Promise<CartItem[]> {
  await getRedisClient().hdel(cartKey(userId), productId);
  return getCart(userId);
}

export async function clearCart(userId: string): Promise<void> {
  await getRedisClient().del(cartKey(userId));
}
