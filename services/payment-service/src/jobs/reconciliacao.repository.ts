import { TransactionStatus, TransactionType } from '@prisma/client';
import { getPrisma } from '../config/database';
import type { TentativaPresa } from './reconciliacao';

/**
 * Tentativas que comecaram e nunca terminaram.
 *
 * O rastro e exatamente o que o comentario do criarPagamento descreve: a linha
 * de AUTHORIZE nasce ANTES da chamada externa (write-ahead), entao uma que
 * continue PENDING e sem providerRef significa "chamamos o provedor e nao
 * sabemos o que aconteceu".
 *
 * O attemptCount vem do Payment, e o ATUAL e o certo: enquanto o pagamento
 * estiver preso em PROCESSING, nenhuma tentativa nova entra (a matriz so admite
 * PENDING e FAILED), entao o valor de agora e o mesmo que compos a chave de
 * idempotencia do provedor.
 */
export async function buscarTentativasPresas(limite: Date, lote: number): Promise<TentativaPresa[]> {
  const presas = await getPrisma().paymentTransaction.findMany({
    where: {
      type: TransactionType.AUTHORIZE,
      status: TransactionStatus.PENDING,
      providerRef: null,
      createdAt: { lt: limite },
    },
    // Mais antigas primeiro: sao as que ha mais tempo travam um cliente.
    orderBy: { createdAt: 'asc' },
    take: lote,
    include: { payment: { select: { attemptCount: true } } },
  });

  return presas.map((t) => ({
    id: t.id,
    paymentId: t.paymentId,
    attemptCount: t.payment.attemptCount,
  }));
}
