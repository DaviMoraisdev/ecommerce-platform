import { Request, Response } from 'express';
import * as stockService from '../services/stock.service';

function handleError(error: any, res: Response): void {
  if (error.message === 'INVALID_AMOUNT') {
    res.status(400).json({ error: 'A quantidade deve ser um inteiro positivo' });
    return;
  }
  if (error.message === 'INVALID_QUANTITY') {
    res.status(400).json({ error: 'A quantidade deve ser um inteiro nao-negativo' });
    return;
  }
  if (error.message === 'INVALID_PRODUCT_ID') {
    res.status(400).json({ error: 'productId invalido' });
    return;
  }
  if (error.message === 'INVALID_ORDER_ID') {
    res.status(400).json({ error: 'orderId invalido' });
    return;
  }
  if (error.message === 'QUANTITY_BELOW_RESERVED') {
    res.status(409).json({ error: 'A nova quantidade e menor que o estoque ja reservado' });
    return;
  }
  if (error.message === 'PRODUCT_NOT_FOUND') {
    res.status(404).json({ error: 'Estoque nao encontrado para o produto' });
    return;
  }
  if (error.message === 'INSUFFICIENT_STOCK') {
    res.status(409).json({ error: 'Estoque insuficiente' });
    return;
  }
  if (error.message === 'INVALID_RELEASE') {
    res.status(409).json({ error: 'Liberacao invalida: reserva inexistente ou menor que o solicitado' });
    return;
  }
  if (error.message === 'INCONSISTENCIA_RESERVA') {
    res.status(500).json({ error: 'Inconsistencia ao liberar reserva' });
    return;
  }
  res.status(500).json({ error: 'Erro interno do servidor' });
}

export async function setStock(req: Request, res: Response): Promise<void> {
  try {
    const { productId, quantity } = req.body;
    if (!productId || quantity === undefined || quantity < 0) {
      res.status(400).json({ error: 'productId e quantity (>= 0) sao obrigatorios' });
      return;
    }
    const inventory = await stockService.setStock(productId, quantity);
    res.status(200).json(inventory);
  } catch (error: any) {
    handleError(error, res);
  }
}

export async function getAvailability(req: Request, res: Response): Promise<void> {
  try {
    const productId = String(req.params.productId);
    const availability = await stockService.getAvailability(productId);
    if (!availability) {
      res.status(404).json({ error: 'Estoque nao encontrado para o produto' });
      return;
    }
    res.status(200).json(availability);
  } catch (error: any) {
    handleError(error, res);
  }
}

export async function reserve(req: Request, res: Response): Promise<void> {
  try {
    const { productId, amount, orderId } = req.body;
    if (!productId || amount === undefined || !orderId) {
      res.status(400).json({ error: 'productId, amount e orderId sao obrigatorios' });
      return;
    }
    const result = await stockService.reserveStock(productId, amount, orderId);
    res.status(200).json(result);
  } catch (error: any) {
    handleError(error, res);
  }
}

export async function release(req: Request, res: Response): Promise<void> {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      res.status(400).json({ error: 'orderId e obrigatorio' });
      return;
    }
    const result = await stockService.releaseByOrder(orderId);
    res.status(200).json(result);
  } catch (error: any) {
    handleError(error, res);
  }
}
