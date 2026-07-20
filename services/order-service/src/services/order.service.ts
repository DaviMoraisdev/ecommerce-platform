import { Order, OrderStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { assertTransition } from '../domain/order-status';

// Muda o status do pedido validando a transicao e registrando o historico.
// Status + historico sao gravados na MESMA transacao: ou os dois, ou nenhum.
export async function updateOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  changedBy: string
): Promise<Order> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new Error('PEDIDO_NAO_ENCONTRADO');
    }

    // Regra de dominio validada ANTES de qualquer escrita.
    assertTransition(order.status, newStatus);

    // Compare-and-swap: so atualiza se o status AINDA for o que foi lido.
    // Se outra requisicao mudou nesse meio-tempo, count = 0 -> conflito.
    const result = await tx.order.updateMany({
      where: { id: orderId, status: order.status },
      data: { status: newStatus },
    });
    if (result.count === 0) {
      throw new Error('CONFLITO_DE_ESTADO');
    }

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: newStatus,
        changedBy,
      },
    });

    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}

export async function getStatusHistory(orderId: string) {
  return prisma.orderStatusHistory.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
}
