import { Request, Response } from 'express';
import { OrderStatus } from '@prisma/client';
import * as orderService from '../services/order.service';

function getUserId(req: Request): string {
  return (req as any).userId;
}
function getUserRole(req: Request): string {
  return (req as any).userRole;
}

// Traduz erro de dominio -> HTTP. Retorna true se tratou.
function mapOrderError(e: unknown, res: Response): boolean {
  if (!(e instanceof Error)) return false;
  switch (e.message) {
    case 'CARRINHO_VAZIO':
      res.status(400).json({ error: 'Carrinho vazio' });
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
  // O token do usuario e repassado ao cart-service (identidade do dono).
  const userToken = req.headers.authorization as string;
  try {
    const order = await orderService.createOrder(getUserId(req), userToken);
    res.status(201).json(order);
  } catch (e: unknown) {
    if (!mapOrderError(e, res)) throw e;
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const order = await orderService.getOrderById(String(req.params.id));
  if (!order) {
    res.status(404).json({ error: 'Pedido nao encontrado' });
    return;
  }
  // Ownership: so o dono do pedido ou um ADMIN pode ver.
  if (order.userId !== getUserId(req) && getUserRole(req) !== 'ADMIN') {
    res.status(403).json({ error: 'Acesso negado' });
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
    const order = await orderService.updateOrderStatus(
      String(req.params.id),
      status as OrderStatus,
      getUserId(req)
    );
    res.status(200).json(order);
  } catch (e: unknown) {
    if (!mapOrderError(e, res)) throw e;
  }
}
