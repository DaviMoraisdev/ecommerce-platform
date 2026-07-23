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
  const oid = orderId.trim();
  if (oid.length > 128) {
    throw new Error('INVALID_ORDER_ID');
  }

  return prisma.$transaction(async (tx) => {
    // IDEMPOTENCIA por identidade logica (orderId, productId) — QUALQUER status.
    // A reserva de um produto num pedido e uma operacao de uma vez so.
    const existente = await tx.reservation.findFirst({
      where: { orderId: oid, productId },
    });
    if (existente) {
      // P1: retry APOS liberar nao pode re-debitar — o ciclo ja se encerrou.
      if (existente.status === 'RELEASED') {
        throw new Error('RESERVA_JA_LIBERADA');
      }
      // P2: idempotente so se a quantidade bate; divergencia e conflito
      // (nao devolve sucesso silencioso com quantidade menor).
      if (existente.quantity !== amount) {
        throw new Error('RESERVA_QUANTIDADE_DIVERGENTE');
      }
      const inv = await tx.inventory.findUniqueOrThrow({ where: { productId } });
      return {
        reservationId: existente.id,
        productId,
        quantity: inv.quantity,
        reserved: inv.reserved,
        available: inv.quantity - inv.reserved,
      };
    }

    // Debito ATOMICO (guard contra corrida no proprio WHERE).
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

    // A unique PARCIAL (orderId, productId) WHERE ACTIVE protege contra corrida:
    // dois reserves simultaneos do mesmo pedido+produto -> um cria, o outro
    // falha o create e reverte a transacao inteira (o debito volta).
    const reservation = await tx.reservation.create({
      data: { productId, quantity: amount, orderId: oid, status: 'ACTIVE' },
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
  const oid = orderId.trim();
  if (oid.length > 128) {
    throw new Error('INVALID_ORDER_ID');
  }

  return prisma.$transaction(async (tx) => {
    // CLAIM ATOMICO: transicao condicional ACTIVE -> RELEASED, retornando
    // apenas as linhas que ESTA transacao reivindicou. Uma release concorrente
    // do mesmo pedido nao reivindica de novo (ja nao ha ACTIVE) -> sem duplo debito.
    const claimed = await tx.$queryRaw<Array<{ productId: string; quantity: number }>>`
      UPDATE reservations
      SET status = 'RELEASED'::"ReservationStatus", "releasedAt" = NOW()
      WHERE "orderId" = ${oid} AND status = 'ACTIVE'::"ReservationStatus"
      RETURNING "productId", quantity
    `;

    // Ordem deterministica de lock (evita deadlock entre releases concorrentes
    // de pedidos que compartilham produtos).
    claimed.sort((a, b) => a.productId.localeCompare(b.productId));

    for (const r of claimed) {
      const affected = await tx.$executeRaw`
        UPDATE inventory
        SET reserved = reserved - ${r.quantity}, "updatedAt" = NOW()
        WHERE "productId" = ${r.productId} AND reserved >= ${r.quantity}
      `;
      // Se o estoque NAO pode ser devolvido, aborta TUDO (o claim tambem reverte).
      // Nao ha mais "sucesso falso" com a reserva marcada RELEASED sem devolucao.
      if (affected !== 1) {
        throw new Error('INCONSISTENCIA_RESERVA');
      }
    }

    return { orderId: oid, released: claimed.length };
  });
}

export async function getReservations(orderId: string) {
  return prisma.reservation.findMany({
    where: { orderId: orderId.trim() },
    orderBy: { createdAt: 'asc' },
  });
}
