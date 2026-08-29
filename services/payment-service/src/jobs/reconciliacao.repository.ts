import { TransactionStatus, TransactionType, type Prisma } from '@prisma/client';
import { getPrisma } from '../config/database';
import type { CursorDaVarredura, TentativaPresa } from './reconciliacao';

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
 *
 * PAGINACAO POR CHAVE (`apos`), nao por `skip` nem pelo `cursor` do Prisma:
 * offset se desloca quando uma linha e resolvida no meio da varredura, e o
 * cursor nativo localiza a linha do cursor por id — se ela deixou de ser
 * candidata, a pagina seguinte fica indefinida. A comparacao lexicografica
 * `(createdAt, id) > (cursor)` depende so de valores.
 */
export async function buscarTentativasPresas(
  limite: Date,
  lote: number,
  apos?: CursorDaVarredura,
): Promise<TentativaPresa[]> {
  const base: Prisma.PaymentTransactionWhereInput = {
    type: TransactionType.AUTHORIZE,
    status: TransactionStatus.PENDING,
    providerRef: null,
    createdAt: { lt: limite },
  };

  const depoisDoCursor: Prisma.PaymentTransactionWhereInput[] = apos
    ? [
        {
          OR: [
            { createdAt: { gt: apos.createdAt } },
            { AND: [{ createdAt: apos.createdAt }, { id: { gt: apos.id } }] },
          ],
        },
      ]
    : [];

  const presas = await getPrisma().paymentTransaction.findMany({
    where: { AND: [base, ...depoisDoCursor] },
    // Mais antigas primeiro: sao as que ha mais tempo travam um cliente. O `id`
    // e desempate ESTAVEL — sem ele, duas linhas com o mesmo createdAt podem
    // trocar de posicao entre paginas e uma delas nunca ser lida.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: lote,
    include: { payment: { select: { attemptCount: true } } },
  });

  return presas.map((t) => ({
    id: t.id,
    paymentId: t.paymentId,
    attemptCount: t.payment.attemptCount,
    createdAt: t.createdAt,
  }));
}
