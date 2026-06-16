import { prisma } from '../config/database';
import { Prisma } from '@prisma/client';

// Valida que o valor e um inteiro finito e positivo
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export async function setStock(productId: string, quantity: number) {
  if (!productId || typeof productId !== 'string') {
    throw new Error('INVALID_PRODUCT_ID');
  }
  if (!isNonNegativeInt(quantity)) {
    throw new Error('INVALID_AMOUNT');
  }

  // Verifica se a nova quantidade nao fica abaixo do que ja esta reservado
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

// Reserva ATOMICA: um unico UPDATE condicional. A clausula WHERE garante
// que so reserva se houver disponivel suficiente. O banco executa isso
// como operacao indivisivel — nao ha fresta entre verificar e escrever.
export async function reserveStock(productId: string, amount: number) {
  if (!isPositiveInt(amount)) {
    throw new Error('INVALID_AMOUNT');
  }

  const affected = await prisma.$executeRaw`
    UPDATE inventory
    SET reserved = reserved + ${amount}, "updatedAt" = NOW()
    WHERE "productId" = ${productId}
      AND quantity - reserved >= ${amount}
  `;

  // affected = numero de linhas atualizadas. 0 significa que ou o produto
  // nao existe, ou nao havia disponivel suficiente.
  if (affected === 0) {
    // Distingue "nao existe" de "sem estoque" para o status HTTP correto
    const exists = await prisma.inventory.findUnique({ where: { productId } });
    if (!exists) {
      throw new Error('PRODUCT_NOT_FOUND');
    }
    throw new Error('INSUFFICIENT_STOCK');
  }

  return await getAvailability(productId);
}

// Liberacao ATOMICA: mesma logica. So libera se houver reserva suficiente.
export async function releaseStock(productId: string, amount: number) {
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
