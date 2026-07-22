import { prisma } from '../config/database';

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateProductId(productId: unknown): asserts productId is string {
  if (!productId || typeof productId !== 'string') {
    throw new Error('INVALID_PRODUCT_ID');
  }
}

export async function setStock(productId: string, quantity: number) {
  validateProductId(productId);
  if (!isNonNegativeInt(quantity)) {
    throw new Error('INVALID_QUANTITY');
  }

  const existing = await prisma.inventory.findUnique({ where: { productId } });
  if (existing && quantity < existing.reserved) {
    throw new Error('QUANTITY_BELOW_RESERVED');
  }

  return await prisma.inventory.upsert({
    where: { productId },
    update: { quantity },
    create: { productId, quantity, reserved: 0 },
  });
}

export async function getAvailability(productId: string) {
  validateProductId(productId);

  const inventory = await prisma.inventory.findUnique({
    where: { productId },
  });

  if (!inventory) {
    return null;
  }

  return {
    productId: inventory.productId,
    quantity: inventory.quantity,
    reserved: inventory.reserved,
    available: inventory.quantity - inventory.reserved,
  };
}

export async function reserveStock(
  productId: string,
  amount: number,
  orderId: string
) {
  validateProductId(productId);
  if (!isPositiveInt(amount)) {
    throw new Error('INVALID_AMOUNT');
  }
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    throw new Error('INVALID_ORDER_ID');
  }

  return prisma.$transaction(async (tx) => {
    // Incremento ATOMICO do reserved (guard available >= amount). Se outra
    // reserva concorrente esvaziou o estoque, este UPDATE afeta 0 linhas.
    const affected = await tx.$executeRaw`
      UPDATE inventory
      SET reserved = reserved + ${amount}, "updatedAt" = NOW()
      WHERE "productId" = ${productId}
        AND quantity - reserved >= ${amount}
    `;
    if (affected === 0) {
      const exists = await tx.inventory.findUnique({ where: { productId } });
      if (!exists) {
        throw new Error('PRODUCT_NOT_FOUND');
      }
      throw new Error('INSUFFICIENT_STOCK');
    }

    // A reserva so nasce se o estoque foi debitado — as duas na mesma transacao.
    const reservation = await tx.reservation.create({
      data: { productId, quantity: amount, orderId, status: 'ACTIVE' },
    });

    const inv = await tx.inventory.findUniqueOrThrow({ where: { productId } });
    return {
      reservationId: reservation.id,
      productId,
      quantity: inv.quantity,
      reserved: inv.reserved,
      available: inv.quantity - inv.reserved,
    };
  });
}

export async function releaseByOrder(orderId: string) {
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    throw new Error('INVALID_ORDER_ID');
  }

  return prisma.$transaction(async (tx) => {
    // Posse estrutural: so tocamos reservas ATIVAS DESTE pedido.
    const ativas = await tx.reservation.findMany({
      where: { orderId, status: 'ACTIVE' },
    });

    for (const r of ativas) {
      // Devolve o estoque (guard reserved >= quantity como rede de seguranca).
      await tx.$executeRaw`
        UPDATE inventory
        SET reserved = reserved - ${r.quantity}, "updatedAt" = NOW()
        WHERE "productId" = ${r.productId}
          AND reserved >= ${r.quantity}
      `;
      await tx.reservation.update({
        where: { id: r.id },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
    }

    // Idempotente: sem reservas ativas -> released: 0, sem erro.
    return { orderId, released: ativas.length };
  });
}

export async function getReservations(orderId: string) {
  return prisma.reservation.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
}
