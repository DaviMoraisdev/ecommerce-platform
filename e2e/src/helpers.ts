import * as dotenv from 'dotenv';
dotenv.config();
import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { resolveConfig, redactUrl } from './config';

const cfg = resolveConfig();
const SECRET = cfg.secret;
export const URLS = {
  product: cfg.urls.product,
  inventory: cfg.urls.inventory,
  cart: cfg.urls.cart,
  order: cfg.urls.order,
};
const AUTH = cfg.urls.auth;
const REDIS = cfg.urls.redis;
export const PAYMENT_URL = cfg.urls.payment;
const WEBHOOK_SECRET = cfg.webhookSecret;
const HTTP_TIMEOUT_MS = cfg.httpTimeoutMs;

export function mintToken(id: string, role = 'ADMIN', expiresIn: string | number = '1h'): string {
  return jwt.sign({ id, email: id + '@e2e.dev', role }, SECRET, { expiresIn } as jwt.SignOptions);
}

export function key(prefix = 'e2e'): string {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

function trunc(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 200 ? s.slice(0, 200) + '...' : String(s);
}

export async function request(
  method: string,
  url: string,
  opts: {
    token?: string;
    body?: unknown;
    idempotencyKey?: string;
    /** Cabecalhos extras (assinatura de webhook). */
    headers?: Record<string, string>;
    /** Corpo JA serializado: um webhook assinado tem de ir byte a byte. */
    rawBody?: string;
  } = {}
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  if (opts.body !== undefined || opts.rawBody !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.headers) Object.assign(headers, opts.headers);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(method + ' ' + redactUrl(url) + ': timeout apos ' + HTTP_TIMEOUT_MS + 'ms');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function seedProduct(token: string, price: number): Promise<string> {
  const r = await request('POST', URLS.product + '/products', {
    token,
    body: { name: 'e2e-' + key(), description: 'e2e', price, category: 'e2e' },
  });
  if (r.status !== 201 || typeof r.body?._id !== 'string') {
    throw new Error('seedProduct falhou: ' + r.status + ' ' + trunc(r.body));
  }
  return r.body._id;
}

export async function cleanupProduct(token: string, productId: string): Promise<void> {
  const r = await request('DELETE', URLS.product + '/products/' + productId, { token });
  if (![200, 204, 404].includes(r.status)) {
    console.warn('[e2e] cleanupProduct: status inesperado ' + r.status + ' para ' + productId);
  }
}

export async function setStock(token: string, productId: string, quantity: number): Promise<void> {
  const r = await request('POST', URLS.inventory + '/stock', { token, body: { productId, quantity } });
  if (r.status !== 200) throw new Error('setStock falhou: ' + r.status + ' ' + trunc(r.body));
}

export async function getStock(
  productId: string
): Promise<{ productId: string; quantity: number; reserved: number; available: number }> {
  const r = await request('GET', URLS.inventory + '/stock/' + productId);
  const b = r.body;
  if (
    r.status !== 200 ||
    typeof b?.productId !== 'string' ||
    typeof b?.quantity !== 'number' ||
    typeof b?.reserved !== 'number' ||
    typeof b?.available !== 'number'
  ) {
    throw new Error('getStock falhou/contrato invalido: ' + r.status + ' ' + trunc(b));
  }
  return b;
}

export async function addToCart(token: string, productId: string, quantity: number): Promise<HttpResult> {
  return request('POST', URLS.cart + '/cart/items', { token, body: { productId, quantity } });
}

export async function getCart(token: string): Promise<HttpResult> {
  return request('GET', URLS.cart + '/cart', { token });
}

export async function createOrder(token: string, idempotencyKey: string): Promise<HttpResult> {
  return request('POST', URLS.order + '/orders', { token, body: {}, idempotencyKey });
}

export async function registerAndLogin(): Promise<{ token: string; userId: string; email: string }> {
  const email = 'e2e-' + key() + '@e2e.dev';
  const password = 'Senha123!';
  const reg = await request('POST', AUTH + '/auth/register', {
    body: { email, password, name: 'e2e user' },
  });
  if (reg.status !== 201) throw new Error('register falhou: ' + reg.status + ' ' + trunc(reg.body));
  const login = await request('POST', AUTH + '/auth/login', { body: { email, password } });
  if (
    login.status !== 200 ||
    typeof login.body?.accessToken !== 'string' ||
    typeof login.body?.user?.id !== 'string' ||
    login.body.user.id === ''
  ) {
    throw new Error('login falhou/contrato invalido: ' + login.status + ' ' + trunc(login.body));
  }
  return { token: login.body.accessToken, userId: login.body.user.id, email };
}

let redisClient: Redis | null = null;
function getRedis(): Redis {
  if (!redisClient) redisClient = new Redis(REDIS, { maxRetriesPerRequest: 2 });
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => undefined);
    redisClient = null;
  }
}

// Poll do marcador que o notification grava ao processar (outbox->relay->broker->consumer).
export async function waitForNotification(orderId: string, type: string, timeoutMs = 8000): Promise<boolean> {
  const k = 'notif:proc:' + orderId + ':' + type;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await getRedis().get(k)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export async function health(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, base] of Object.entries(URLS)) {
    try {
      out[name] = (await request('GET', base + '/health')).status;
    } catch {
      out[name] = 0;
    }
  }
  return out;
}

// ===================== payment-service (Bloco 8f) =====================

export async function createPayment(
  token: string,
  orderId: string,
  paymentMethodToken: string,
  idempotencyKey: string
): Promise<HttpResult> {
  return request('POST', PAYMENT_URL + '/payments', {
    token,
    body: { orderId, paymentMethodToken },
    idempotencyKey,
  });
}

export async function getOrder(token: string, orderId: string): Promise<HttpResult> {
  return request('GET', URLS.order + '/orders/' + orderId, { token });
}

/**
 * Espera o pedido chegar a um status, por polling com teto. Nunca `sleep`
 * fixo: o caminho passa por outbox -> relay -> broker -> consumidor, e o tempo
 * varia. Devolve o ultimo status visto para a mensagem de falha ser util.
 */
export async function waitForOrderStatus(
  token: string,
  orderId: string,
  status: string,
  timeoutMs: number,
  intervalMs = 500
): Promise<string> {
  const limite = Date.now() + timeoutMs;
  let visto = '';
  while (Date.now() < limite) {
    const r = await getOrder(token, orderId);
    visto = String(r.body?.status ?? r.status);
    if (visto === status) return visto;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return visto;
}

/**
 * Assina como o FakeProvider verifica: header `x-fake-signature: t=<s>,v1=<hex>`,
 * HMAC-SHA256 sobre `"<t>." + corpo`. O timestamp entra no material assinado
 * de proposito (anti-replay); a tolerancia do servico e de 300 s.
 */
export function signWebhook(
  body: unknown,
  opts: { secret?: string; timestampSeconds?: number } = {}
): { rawBody: string; header: string } {
  const rawBody = JSON.stringify(body);
  const t = opts.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', opts.secret ?? WEBHOOK_SECRET)
    .update(Buffer.concat([Buffer.from(t + '.', 'utf8'), Buffer.from(rawBody, 'utf8')]))
    .digest('hex');
  return { rawBody, header: 't=' + t + ',v1=' + v1 };
}

export async function postWebhook(signed: { rawBody: string; header: string }): Promise<HttpResult> {
  return request('POST', PAYMENT_URL + '/webhooks/fake', {
    rawBody: signed.rawBody,
    headers: { 'x-fake-signature': signed.header },
  });
}

/** Corpo minimo que passa no envelope e na estrutura de cobranca do fake.wire. */
export function fakeWebhookBody(overrides: Partial<{ id: string; type: string; charge_ref: string }> = {}) {
  return {
    id: overrides.id ?? 'evt_' + key(),
    type: overrides.type ?? 'payment.succeeded',
    created_at: new Date().toISOString(),
    data: {
      charge_ref: overrides.charge_ref ?? 'ch_inexistente_' + key(),
      state: 'SUCCEEDED',
      captured_amount_cents: 1000,
      refunded_amount_cents: 0,
      refund_ref: null,
      decline_code: null,
    },
  };
}
