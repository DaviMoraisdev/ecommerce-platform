import { DomainError } from '../domain/errors';

const TIMEOUT_MS = 5000;

export interface CartItem {
  productId: string;
  quantity: number;
  name: string | null;
  price: number | null;
  subtotal: number | null;
  available: number | null;
}
export interface DetailedCart {
  items: CartItem[];
  total: number;
  partial: boolean;
}

async function callCart(
  method: string,
  userToken: string
): Promise<Response> {
  const base = process.env.CART_SERVICE_URL || 'http://localhost:3005';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(base + '/cart', {
      method,
      headers: { Authorization: userToken },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Busca o carrinho ENRIQUECIDO (com preco/subtotal) usando o token DO USUARIO.
export async function getCart(userToken: string): Promise<DetailedCart> {
  let res: Response;
  try {
    res = await callCart('GET', userToken);
  } catch {
    throw new DomainError('CART_INDISPONIVEL');
  }
  if (!res.ok) {
    throw new DomainError('CART_INDISPONIVEL');
  }
  return (await res.json()) as DetailedCart;
}

export async function clearCart(userToken: string): Promise<void> {
  let res: Response;
  try {
    res = await callCart('DELETE', userToken);
  } catch {
    throw new DomainError('CART_LIMPEZA_FALHOU');
  }
  if (!res.ok) {
    throw new DomainError('CART_LIMPEZA_FALHOU');
  }
}
