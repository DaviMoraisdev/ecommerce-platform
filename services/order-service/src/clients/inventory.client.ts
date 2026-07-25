import jwt from 'jsonwebtoken';
import { DomainError } from '../domain/errors';

const TIMEOUT_MS = 5000;

// Token de SERVICO: o order-service se identifica com role ADMIN para chamar
// o inventory (release exige ADMIN/SELLER). E a ponte enquanto nao ha auth
// servico-a-servico de verdade (Fase 7). Assinado com o segredo compartilhado.
function serviceToken(): string {
  return jwt.sign(
    { id: 'order-service', role: 'ADMIN' },
    process.env.JWT_SECRET as string,
    { expiresIn: '5m' }
  );
}

async function postInventory(path: string, body: unknown): Promise<Response> {
  const base = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3004';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + serviceToken(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function reserve(
  productId: string,
  amount: number,
  orderId: string
): Promise<void> {
  let res: Response;
  try {
    res = await postInventory('/stock/reserve', { productId, amount, orderId });
  } catch {
    throw new DomainError('INVENTORY_INDISPONIVEL');
  }
  if (res.ok) return;
  if (res.status === 404) throw new DomainError('PRODUTO_SEM_ESTOQUE');
  if (res.status === 409) throw new DomainError('ESTOQUE_INSUFICIENTE');
  throw new DomainError('INVENTORY_INDISPONIVEL');
}

// release e a compensacao. Idempotente no inventory; nunca lanca "nao achou".
export async function release(orderId: string): Promise<void> {
  let res: Response;
  try {
    res = await postInventory('/stock/release', { orderId });
  } catch {
    throw new DomainError('RELEASE_FALHOU');
  }
  if (!res.ok) throw new DomainError('RELEASE_FALHOU');
}
