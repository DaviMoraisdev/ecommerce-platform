import { Request, Response } from 'express';
import { OrderStatus } from '@prisma/client';
import * as orderService from '../services/order.service';
import { DomainError } from '../domain/errors';

function getUserId(req: Request): string {
  return (req as any).userId;
}
function getUserRole(req: Request): string {
  return (req as any).userRole;
}

// Traduz erro de dominio -> HTTP. Retorna true se tratou.
function mapOrderError(e: unknown, res: Response): boolean {
  if (!(e instanceof DomainError)) return false;
  switch (e.code) {
    case 'CARRINHO_VAZIO':
      res.status(400).json({ error: 'Carrinho vazio' });
      return true;
    case 'CARRINHO_INVALIDO':
      res.status(502).json({ error: 'Resposta invalida do servico de carrinho' });
      return true;
    case 'CARRINHO_SEM_PRECO':
      res.status(409).json({ error: 'Carrinho tem item sem preco disponivel' });
      return true;
    case 'ESTOQUE_INSUFICIENTE':
      res.status(409).json({ error: 'Estoque insuficiente para um dos itens' });
      return true;
    case 'PRODUTO_SEM_ESTOQUE':
      res.status(409).json({ error: 'Produto sem estoque cadastrado' });
      return true;
    case 'CART_INDISPONIVEL':
      res.status(503).json({ error: 'Servico de carrinho indisponivel' });
      return true;
    case 'INVENTORY_INDISPONIVEL':
      res.status(503).json({ error: 'Servico de estoque indisponivel' });
      return true;
    case 'PEDIDO_NAO_ENCONTRADO':
    case 'ITEM_NAO_ENCONTRADO':
      res.status(404).json({ error: 'Recurso nao encontrado' });
      return true;
    case 'CONFLITO_DE_ESTADO':
      res.status(409).json({ error: 'Conflito de concorrencia; tente de novo' });
      return true;
    case 'TRANSICAO_INVALIDA':
      res.status(409).json({ error: 'Transicao de status invalida' });
      return true;
    case 'AUTOR_INVALIDO':
      res.status(400).json({ error: 'Autor da mudanca invalido' });
      return true;
    default:
      return false;
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const userToken = req.headers.authorization as string;
  const idempotencyKey = req.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    res.status(400).json({ error: 'Header Idempotency-Key obrigatorio' });
    return;
  }
  try {
    const order = await orderService.createOrder(
      getUserId(req),
      userToken,
      idempotencyKey.trim()
    );
    res.status(201).json(order);
  } catch (e: unknown) {
    if (!mapOrderError(e, res)) throw e;
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const order = await orderService.getOrderById(String(req.params.id));
  const isAdmin = getUserRole(req) === 'ADMIN';
  // Nao-admin: 404 para inexistente E para pedido de outro (nao revela existencia).
  if (!order || (!isAdmin && order.userId !== getUserId(req))) {
    res.status(404).json({ error: 'Pedido nao encontrado' });
    return;
  }
  res.status(200).json(order);
}

export async function changeStatus(req: Request, res: Response): Promise<void> {
  const { status } = req.body;
  const validos = Object.values(OrderStatus) as string[];
  if (typeof status !== 'string' || !validos.includes(status)) {
    res.status(400).json({ error: 'status invalido' });
    return;
  }
  try {
    // changedBy vem do JWT (nunca do payload) — paga a divida do Bloco 6.
    const order = await orderService.changeOrderStatus(
      String(req.params.id),
      status as OrderStatus,
      getUserId(req)
    );
    res.status(200).json(order);
  } catch (e: unknown) {
    if (!mapOrderError(e, res)) throw e;
  }
}
