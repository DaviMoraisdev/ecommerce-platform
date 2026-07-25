import { Order, OrderStatus, Prisma } from '@prisma/client';
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
function ehItemValido(i: any): boolean {
  return (
    typeof i === 'object' &&
    i !== null &&
    typeof i.productId === 'string' &&
    i.productId.trim() !== '' &&
    Number.isInteger(i.quantity) &&
    i.quantity > 0 &&
    typeof i.price === 'number' &&
    Number.isFinite(i.price) &&
    i.price >= 0
  );
}

// Valida a resposta do cart-service em RUNTIME (o cast do TS nao garante nada).
// Recalcula subtotal/total no servidor. Item estruturalmente invalido =
// contrato quebrado da dependencia (CARRINHO_INVALIDO -> 502).
function montarItens(cart: cartClient.DetailedCart): {
  itens: ItemPedido[];
  total: number;
} {
  if (!cart || !Array.isArray(cart.items)) {
    throw new DomainError('CARRINHO_INVALIDO');
  }
  if (cart.items.length === 0) {
    throw new DomainError('CARRINHO_VAZIO');
  }
  if (cart.partial) {
    throw new DomainError('CARRINHO_SEM_PRECO');
  }
  const itens = cart.items.map((i: any) => {
    if (i && i.price === null) {
      throw new DomainError('CARRINHO_SEM_PRECO');
    }
    if (!ehItemValido(i)) {
      throw new DomainError('CARRINHO_INVALIDO');
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
export async function createOrder(
  userId: string,
  userToken: string,
  idempotencyKey: string
) {
  // Idempotencia (chave estavel do cliente): retry retorna o pedido existente,
  // sem reservar nem criar de novo.
  const existente = await prisma.order.findUnique({
    where: { idempotencyKey },
    include: { items: true },
  });
  if (existente) return existente;

  const orderId = randomUUID();
  const cart = await cartClient.getCart(userToken);
  const { itens, total } = montarItens(cart);

  try {
    for (const item of itens) {
      await inventoryClient.reserve(item.productId, item.quantity, orderId);
    }

    let order;
    try {
      order = await prisma.order.create({
        data: {
          id: orderId,
          userId,
          status: 'PENDENTE',
          total,
          idempotencyKey,
          items: { create: itens },
        },
        include: { items: true },
      });
    } catch (e) {
      // Concorrencia com a MESMA chave: outro request criou primeiro.
      // Compensa as reservas DESTE perdedor e devolve o pedido vencedor.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await compensar(orderId, e);
        const vencedor = await prisma.order.findUnique({
          where: { idempotencyKey },
          include: { items: true },
        });
        if (vencedor) return vencedor;
      }
      throw e;
    }

    // Remove SO os itens comprados: o que o usuario adicionou durante o
    // checkout sobrevive. Falha aqui e apenas logada.
    await removerItensComprados(userToken, itens);
    return order;
  } catch (err) {
    await compensar(orderId, err);
    throw err;
  }
}

async function removerItensComprados(
  userToken: string,
  itens: ItemPedido[]
): Promise<void> {
  for (const item of itens) {
    try {
      await cartClient.removeItem(item.productId, userToken);
    } catch {
      console.warn('[order] falha ao remover ' + item.productId + ' do carrinho');
    }
  }
}

// Registro DURAVEL: se o release de compensacao falhar, persiste a pendencia
// (sobrevive a restart). Um job (Fase 10) reprocessa onde resolvedAt e null.
async function registrarCompensacaoPendente(orderId: string, reason: string): Promise<void> {
  try {
    await prisma.pendingCompensation.create({ data: { orderId, reason } });
  } catch {
    console.error('[order] falha ate ao registrar compensacao pendente de ' + orderId);
  }
}

async function compensar(orderId: string, erroOriginal: unknown): Promise<void> {
  try {
    await inventoryClient.release(orderId);
  } catch (releaseErr) {
    const motivo = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
    const orig = erroOriginal instanceof Error ? erroOriginal.message : String(erroOriginal);
    console.error('[order] COMPENSACAO FALHOU para ' + orderId + ' release=' + motivo + ' erroOriginal=' + orig);
    await registrarCompensacaoPendente(orderId, 'release_falhou:' + motivo);
  }
}

// Orquestra a mudanca de status: aplica a transicao (Bloco 6) e, se CANCELADO,
// libera as reservas no inventory. O status e a fonte da verdade; se o release
// falhar, loga para reconciliacao (o release e idempotente).
export async function changeOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  changedBy: string
) {
  const order = await updateOrderStatus(orderId, newStatus, changedBy);
  if (newStatus === OrderStatus.CANCELADO) {
    try {
      await inventoryClient.release(orderId);
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      console.error('[order] cancelamento de ' + orderId + ' nao liberou o estoque: ' + motivo);
      await registrarCompensacaoPendente(orderId, 'cancel_release_falhou:' + motivo);
    }
  }
  return order;
}

export async function getOrderById(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
}
