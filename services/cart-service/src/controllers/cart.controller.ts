import { Request, Response } from 'express';
import * as cartService from '../services/cart.service';

const MAX_QUANTITY = 10000;
const MAX_PRODUCT_ID_LENGTH = 128;

function getUserId(req: Request): string {
  return (req as any).userId;
}

function validateQuantity(quantity: unknown): string | null {
  if (
    typeof quantity !== 'number' ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > MAX_QUANTITY
  ) {
    return 'quantity deve ser um inteiro entre 1 e ' + MAX_QUANTITY;
  }
  return null;
}

// Normaliza (trim) e valida presenca/tamanho. Retorna o id limpo ou null.
function normalizeProductId(productId: unknown): string | null {
  if (typeof productId !== 'string') return null;
  const trimmed = productId.trim();
  if (trimmed === '' || trimmed.length > MAX_PRODUCT_ID_LENGTH) return null;
  return trimmed;
}

export async function getCart(req: Request, res: Response): Promise<void> {
  const items = await cartService.getCart(getUserId(req));
  res.status(200).json({ items });
}

export async function addItem(req: Request, res: Response): Promise<void> {
  const productId = normalizeProductId(req.body.productId);
  if (!productId) {
    res.status(400).json({ error: 'productId invalido' });
    return;
  }
  const qtyErr = validateQuantity(req.body.quantity);
  if (qtyErr) {
    res.status(400).json({ error: qtyErr });
    return;
  }
  const items = await cartService.addItem(getUserId(req), productId, req.body.quantity);
  res.status(200).json({ items });
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  const productId = normalizeProductId(req.params.productId);
  if (!productId) {
    res.status(400).json({ error: 'productId invalido' });
    return;
  }
  const qtyErr = validateQuantity(req.body.quantity);
  if (qtyErr) {
    res.status(400).json({ error: qtyErr });
    return;
  }
  try {
    const items = await cartService.updateQuantity(
      getUserId(req),
      productId,
      req.body.quantity
    );
    res.status(200).json({ items });
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'ITEM_NAO_ENCONTRADO') {
      res.status(404).json({ error: 'Item nao encontrado no carrinho' });
      return;
    }
    throw e;
  }
}

export async function removeItem(req: Request, res: Response): Promise<void> {
  const productId = normalizeProductId(req.params.productId);
  if (!productId) {
    res.status(400).json({ error: 'productId invalido' });
    return;
  }
  const items = await cartService.removeItem(getUserId(req), productId);
  res.status(200).json({ items });
}

export async function clearCart(req: Request, res: Response): Promise<void> {
  await cartService.clearCart(getUserId(req));
  res.status(204).send();
}
