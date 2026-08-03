import * as dotenv from 'dotenv';
dotenv.config();
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET as string;
const PRODUCT = process.env.PRODUCT_URL || 'http://localhost:3003';
const INVENTORY = process.env.INVENTORY_URL || 'http://localhost:3004';
const CART = process.env.CART_URL || 'http://localhost:3005';
const ORDER = process.env.ORDER_URL || 'http://localhost:3006';

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

// Assina um JWT valido com o segredo compartilhado (claim id -> userId).
export function mintToken(id: string, role = 'ADMIN'): string {
  return jwt.sign({ id, email: id + '@e2e.dev', role }, SECRET, { expiresIn: '1h' });
}

export function key(prefix = 'e2e'): string {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

async function http(
  method: string,
  url: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {}
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// Sobe um produto novo (nome unico) e devolve o _id.
export async function seedProduct(token: string, price: number): Promise<string> {
  const r = await http('POST', PRODUCT + '/products', {
    token,
    body: { name: 'e2e-' + key(), description: 'e2e', price, category: 'e2e' },
  });
  if (r.status !== 201) {
    throw new Error('seedProduct falhou: ' + r.status + ' ' + JSON.stringify(r.body));
  }
  return r.body._id as string;
}

export async function setStock(token: string, productId: string, quantity: number): Promise<void> {
  const r = await http('POST', INVENTORY + '/stock', { token, body: { productId, quantity } });
  if (r.status !== 200) {
    throw new Error('setStock falhou: ' + r.status + ' ' + JSON.stringify(r.body));
  }
}

export async function getStock(
  productId: string
): Promise<{ productId: string; quantity: number; reserved: number; available: number }> {
  const r = await http('GET', INVENTORY + '/stock/' + productId);
  if (r.status !== 200) {
    throw new Error('getStock falhou: ' + r.status + ' ' + JSON.stringify(r.body));
  }
  return r.body;
}

export async function addToCart(token: string, productId: string, quantity: number): Promise<HttpResult> {
  return http('POST', CART + '/cart/items', { token, body: { productId, quantity } });
}

export async function getCart(token: string): Promise<HttpResult> {
  return http('GET', CART + '/cart', { token });
}

export async function createOrder(token: string, idempotencyKey: string): Promise<HttpResult> {
  return http('POST', ORDER + '/orders', { token, body: {}, idempotencyKey });
}

// Verifica se os quatro servicos HTTP estao de pe (retorna status por servico).
export async function health(): Promise<Record<string, number>> {
  const urls: Record<string, string> = { product: PRODUCT, inventory: INVENTORY, cart: CART, order: ORDER };
  const out: Record<string, number> = {};
  for (const [name, base] of Object.entries(urls)) {
    try {
      const r = await fetch(base + '/health');
      out[name] = r.status;
    } catch {
      out[name] = 0;
    }
  }
  return out;
}
