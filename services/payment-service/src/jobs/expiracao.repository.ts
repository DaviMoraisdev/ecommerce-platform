import {
  TransactionStatus,
  TransactionType,
  type Prisma,
} from "@prisma/client";
import { getPrisma } from "../config/database";
import type { TentativaExpirando } from "./expiracao";
import {
  apenasDepoisDoCursor,
  ordenacaoDaVarredura,
  type CursorDaVarredura,
} from "./keyset";

/**
 * Tentativas cuja COBRANCA EXISTE no provedor e que nunca foram concluidas.
 *
 * `providerRef` nao-nulo com a linha ainda PENDING e o rastro do aceite
 * assincrono: o provedor recebeu, devolveu referencia e prometeu avisar depois.
 * Se o aviso nunca vem, ninguem mais fecha esse pagamento — o webhook nao
 * chega, e a reconciliacao do 6b nao alcanca (a populacao dela e `providerRef`
 * NULO). Este e o ultimo caminho por onde um pagamento fica preso para sempre.
 *
 * O `attemptCount` vem do Payment e o ATUAL e o certo, pela mesma razao do 6b:
 * enquanto o pagamento estiver preso em PROCESSING, nenhuma tentativa nova
 * entra, entao o valor de agora e o mesmo que compos a chave do provedor.
 */
export async function buscarTentativasExpirando(
  limite: Date,
  lote: number,
  apos?: CursorDaVarredura,
): Promise<TentativaExpirando[]> {
  const base: Prisma.PaymentTransactionWhereInput = {
    type: TransactionType.AUTHORIZE,
    status: TransactionStatus.PENDING,
    providerRef: { not: null },
    createdAt: { lt: limite },
  };

  const candidatas = await getPrisma().paymentTransaction.findMany({
    where: { AND: [base, ...apenasDepoisDoCursor(apos)] },
    orderBy: ordenacaoDaVarredura(),
    take: lote,
    include: { payment: { select: { attemptCount: true } } },
  });

  return candidatas.map((t) => {
    // O WHERE garante nao-nulo; o TIPO gerado pelo Prisma nao sabe disso.
    // Estreitamento explicito em vez de `!`: se o filtro mudar um dia, isto
    // falha ALTO e nomeia a linha, em vez de entregar `null` ao cancelCharge.
    if (t.providerRef === null) {
      throw new Error(
        `tentativa ${t.id} sem providerRef escapou do filtro da varredura`,
      );
    }

    return {
      id: t.id,
      paymentId: t.paymentId,
      attemptCount: t.payment.attemptCount,
      providerRef: t.providerRef,
      createdAt: t.createdAt,
    };
  });
}
