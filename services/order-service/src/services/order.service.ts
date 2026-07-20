import { Order, OrderStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { assertTransition } from '../domain/order-status';
import { DomainError } from '../domain/errors';

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
