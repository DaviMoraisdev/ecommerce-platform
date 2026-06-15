import { prisma } from '../config/database';

export async function setStock(productId: string, quantity: number) {
  return await prisma.inventory.upsert({
    where: { productId },
    update: { quantity },
    create: { productId, quantity, reserved: 0 },
  });
}

export async function getAvailability(productId: string) {
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

export async function reserveStock(productId: string, amount: number) {
  if (amount <= 0) {
    throw new Error('INVALID_AMOUNT');
  }

  // Transacao atomica: le o estoque travando a linha (FOR UPDATE),
  // verifica disponibilidade e so entao reserva. O lock impede que
  // duas reservas concorrentes leiam o mesmo disponivel.
  return await prisma.$transaction(async (tx) => {
    const inventory = await tx.inventory.findUnique({
      where: { productId },
    });

    if (!inventory) {
      throw new Error('PRODUCT_NOT_FOUND');
    }

    const available = inventory.quantity - inventory.reserved;
    if (available < amount) {
      throw new Error('INSUFFICIENT_STOCK');
    }

    const updated = await tx.inventory.update({
      where: { productId },
      data: { reserved: { increment: amount } },
    });

    return {
      productId: updated.productId,
      quantity: updated.quantity,
      reserved: updated.reserved,
      available: updated.quantity - updated.reserved,
    };
  });
}

export async function releaseStock(productId: string, amount: number) {
  if (amount <= 0) {
    throw new Error('INVALID_AMOUNT');
  }

  return await prisma.$transaction(async (tx) => {
    const inventory = await tx.inventory.findUnique({
      where: { productId },
    });

    if (!inventory) {
      throw new Error('PRODUCT_NOT_FOUND');
    }

    if (inventory.reserved < amount) {
      throw new Error('INVALID_RELEASE');
    }

    const updated = await tx.inventory.update({
      where: { productId },
      data: { reserved: { decrement: amount } },
    });

    return {
      productId: updated.productId,
      quantity: updated.quantity,
      reserved: updated.reserved,
      available: updated.quantity - updated.reserved,
    };
  });
}
