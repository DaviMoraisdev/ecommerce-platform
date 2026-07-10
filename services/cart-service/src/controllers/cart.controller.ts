import { Request, Response } from 'express';
import * as cartService from '../services/cart.service';

function getUserId(req: Request): string {
  return (req as any).userId;
}

function validateQuantity(quantity: unknown): string | null {
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
    return 'quantity deve ser um inteiro maior que zero';
  }
  return null;
}

function validateItemInput(productId: unknown, quantity: unknown): string | null {
  if (typeof productId !== 'string' || productId.trim() === '') {
    return 'productId e obrigatorio';
  }
  return validateQuantity(quantity);
}

export async function getCart(req: Request, res: Response): Promise<void> {
  const items = await cartService.getCart(getUserId(req));
  res.status(200).json({ items });
}

export async function addItem(req: Request, res: Response): Promise<void> {
  const { productId, quantity } = req.body;
  const err = validateItemInput(productId, quantity);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  const items = await cartService.addItem(getUserId(req), productId, quantity);
  res.status(200).json({ items });
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  const productId = String(req.params.productId);
  const { quantity } = req.body;
  const err = validateQuantity(quantity);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  try {
    const items = await cartService.updateQuantity(
      getUserId(req),
      productId,
      quantity
    );
    res.status(200).json({ items });
  } catch (e: any) {
    if (e.message === 'ITEM_NAO_ENCONTRADO') {
      res.status(404).json({ error: 'Item nao encontrado no carrinho' });
      return;
    }
    throw e;
  }
}

export async function removeItem(req: Request, res: Response): Promise<void> {
  const productId = String(req.params.productId);
  const items = await cartService.removeItem(getUserId(req), productId);
  res.status(200).json({ items });
}

export async function clearCart(req: Request, res: Response): Promise<void> {
  await cartService.clearCart(getUserId(req));
  res.status(204).send();
}
