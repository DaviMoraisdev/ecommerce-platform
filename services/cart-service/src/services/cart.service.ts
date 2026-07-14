import { getRedisClient } from '../config/redis';
import { loadConfig } from '../config/env';
import { fetchProduct } from './product.client';

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface CartItemDetailed extends CartItem {
  name: string | null;
  price: number | null;
  subtotal: number | null;
  available: number | null;
}

export interface DetailedCart {
  items: CartItemDetailed[];
  total: number;
  partial: boolean;
}

function cartKey(userId: string): string {
  return 'cart:' + userId;
}

// Arredonda para 2 casas (paliativo de float; solucao real = centavos, em divida).
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function refreshTtl(key: string): Promise<void> {
  const { cartTtlSeconds } = loadConfig();
  await getRedisClient().expire(key, cartTtlSeconds);
}

async function assertProductAllows(
  productId: string,
  desiredQty: number
): Promise<void> {
  const result = await fetchProduct(productId);
  if (result.status === 'not_found') {
    throw new Error('PRODUTO_NAO_ENCONTRADO');
  }
  if (result.status === 'unavailable') {
    throw new Error('PRODUTO_SERVICE_INDISPONIVEL');
  }
  const availability = result.product.availability;
  if (availability !== null && desiredQty > availability.available) {
    throw new Error('ESTOQUE_INSUFICIENTE');
  }
}

export async function getCart(userId: string): Promise<CartItem[]> {
  const hash = await getRedisClient().hgetall(cartKey(userId));
  return Object.entries(hash).map(([productId, qty]) => ({
    productId,
    quantity: Number(qty),
  }));
}

export async function getCartDetailed(userId: string): Promise<DetailedCart> {
  const items = await getCart(userId);
  const detailed = await Promise.all(
    items.map(async (item): Promise<CartItemDetailed> => {
      const result = await fetchProduct(item.productId);
      if (result.status !== 'ok') {
        return {
          productId: item.productId,
          quantity: item.quantity,
          name: null,
          price: null,
          subtotal: null,
          available: null,
        };
      }
      const { name, price, availability } = result.product;
      return {
        productId: item.productId,
        quantity: item.quantity,
        name,
        price,
        subtotal: round2(price * item.quantity),
        available: availability ? availability.available : null,
      };
    })
  );
  // partial = algum item nao pode ser precificado -> total e apenas parcial.
  const partial = detailed.some((i) => i.subtotal === null);
  const total = round2(detailed.reduce((sum, i) => sum + (i.subtotal ?? 0), 0));
  return { items: detailed, total, partial };
}

export async function addItem(
  userId: string,
  productId: string,
  quantity: number
): Promise<CartItem[]> {
  const key = cartKey(userId);
  const currentRaw = await getRedisClient().hget(key, productId);
  const current = currentRaw ? Number(currentRaw) : 0;
  await assertProductAllows(productId, current + quantity);
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
  await assertProductAllows(productId, quantity);
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
  await refreshTtl(key);
  return getCart(userId);
}

export async function clearCart(userId: string): Promise<void> {
  await getRedisClient().del(cartKey(userId));
}
