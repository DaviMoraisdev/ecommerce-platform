import { Order, OrderStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { assertTransition } from '../domain/order-status';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors';
import * as cartClient from '../clients/cart.client';
import * as inventoryClient from '../clients/inventory.client';

const MAX_CHANGED_BY = 128;

// changedBy DEVE vir de contexto autenticado (o chamador). O servico nao aceita
// identidade vinda de payload do cliente — a rota do Bloco 7 passara req.userId.
// Aqui validamos o formato como ultima barreira antes de gravar a trilha.
function normalizeChangedBy(changedBy: unknown): string {
  const v = typeof changedBy === 'string' ? changedBy.trim() : '';
  if (v === '' || v.length > MAX_CHANGED_BY) {
    throw new DomainError('AUTOR_INVALIDO');
  }
  return v;
}

export async function updateOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  changedBy: string
): Promise<Order> {
  const autor = normalizeChangedBy(changedBy);

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new DomainError('PEDIDO_NAO_ENCONTRADO');
    }

    assertTransition(order.status, newStatus);

    // Compare-and-swap: so atualiza se o status AINDA for o que foi lido.
    const result = await tx.order.updateMany({
      where: { id: orderId, status: order.status },
      data: { status: newStatus },
    });
    if (result.count === 0) {
      throw new DomainError('CONFLITO_DE_ESTADO');
    }

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: newStatus,
        changedBy: autor,
      },
    });

    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}

// Ordena por seq (monotonica), nao por createdAt: empates de milissegundo
// deixariam a ordem indefinida.
export async function getStatusHistory(orderId: string) {
  return prisma.orderStatusHistory.findMany({
    where: { orderId },
    orderBy: { seq: 'asc' },
  });
}


interface ItemPedido {
  productId: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

// Valida o carrinho e monta os itens do pedido, recalculando o subtotal e o
// total NO SERVIDOR (nunca confia num total pronto). Rejeita carrinho vazio ou
// com item sem preco (parcial) — nao da para cobrar sem preco.
function montarItens(cart: cartClient.DetailedCart): {
  itens: ItemPedido[];
  total: number;
} {
  if (cart.items.length === 0) {
    throw new DomainError('CARRINHO_VAZIO');
  }
  if (cart.partial) {
    throw new DomainError('CARRINHO_SEM_PRECO');
  }
  const itens = cart.items.map((i) => {
    if (i.price === null) {
      throw new DomainError('CARRINHO_SEM_PRECO');
    }
    const subtotal = Math.round(i.price * i.quantity * 100) / 100;
    return {
      productId: i.productId,
      quantity: i.quantity,
      unitPrice: i.price,
      subtotal,
    };
  });
  const total =
    Math.round(itens.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
  return { itens, total };
}

// SAGA de criacao do pedido. Fluxo com compensacao:
//   1. gera orderId  2. le o carrinho  3. reserva estoque por item
//   4. cria order+itens numa transacao  5. limpa o carrinho
// Falhou depois de reservar? -> release(orderId) desfaz. release do inventory
// e idempotente, entao seguro reexecutar.
export async function createOrder(userId: string, userToken: string) {
  const orderId = randomUUID();

  // 2. Carrinho (token do USUARIO) + validacao/total no servidor.
  const cart = await cartClient.getCart(userToken);
  const { itens, total } = montarItens(cart);

  // 3. Reserva por item, amarrada ao orderId (token de SERVICO no client).
  //    Se qualquer reserva falhar, compensa e propaga.
  const reservados: string[] = [];
  try {
    for (const item of itens) {
      await inventoryClient.reserve(item.productId, item.quantity, orderId);
      reservados.push(item.productId);
    }

    // 4. Persiste order + itens na MESMA transacao (total do servidor).
    const order = await prisma.$transaction(async (tx) => {
      return tx.order.create({
        data: {
          id: orderId,
          userId,
          status: 'PENDENTE',
          total,
          items: { create: itens },
        },
        include: { items: true },
      });
    });

    // 5. Limpa o carrinho. Falha aqui NAO desfaz o pedido (ja pago/reservado);
    //    o pior caso e um carrinho nao esvaziado, corrigivel depois.
    try {
      await cartClient.clearCart(userToken);
    } catch {
      console.warn('[order] pedido ' + orderId + ' criado, mas limpar o carrinho falhou');
    }

    return order;
  } catch (err) {
    // COMPENSACAO: desfaz as reservas ja feitas.
    await compensar(orderId, err);
    throw err;
  }
}

// Compensa liberando as reservas. Se o proprio release falhar, loga o
// incidente (reservas presas) e NAO mascara o erro original. Reconciliacao
// (retry/job) fica como divida — release e idempotente.
async function compensar(orderId: string, erroOriginal: unknown): Promise<void> {
  try {
    await inventoryClient.release(orderId);
  } catch (releaseErr) {
    const motivo = releaseErr instanceof Error ? releaseErr.message : releaseErr;
    const orig = erroOriginal instanceof Error ? erroOriginal.message : erroOriginal;
    console.error(
      '[order] COMPENSACAO FALHOU para ' + orderId +
      ' (reservas podem ficar presas). release=' + motivo + ' erroOriginal=' + orig
    );
  }
}

export async function getOrderById(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
}
