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

export async function reserveStock(productId: string, amount: number) {
  validateProductId(productId);
  if (!isPositiveInt(amount)) {
    throw new Error('INVALID_AMOUNT');
  }

  const affected = await prisma.$executeRaw`
    UPDATE inventory
    SET reserved = reserved + ${amount}, "updatedAt" = NOW()
    WHERE "productId" = ${productId}
      AND quantity - reserved >= ${amount}
  `;

  if (affected === 0) {
    const exists = await prisma.inventory.findUnique({ where: { productId } });
    if (!exists) {
      throw new Error('PRODUCT_NOT_FOUND');
    }
    throw new Error('INSUFFICIENT_STOCK');
  }

  return await getAvailability(productId);
}

export async function releaseStock(productId: string, amount: number) {
  validateProductId(productId);
  if (!isPositiveInt(amount)) {
    throw new Error('INVALID_AMOUNT');
  }

  const affected = await prisma.$executeRaw`
    UPDATE inventory
    SET reserved = reserved - ${amount}, "updatedAt" = NOW()
    WHERE "productId" = ${productId}
      AND reserved >= ${amount}
  `;

  if (affected === 0) {
    const exists = await prisma.inventory.findUnique({ where: { productId } });
    if (!exists) {
      throw new Error('PRODUCT_NOT_FOUND');
    }
    throw new Error('INVALID_RELEASE');
  }

  return await getAvailability(productId);
}
