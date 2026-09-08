import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';

/**
 * Aplica um novo TOTAL reembolsado sobre o pagamento, com compare-and-swap.
 *
 * Extraido do WebhookService no Bloco 7, no segundo uso: o endpoint de reembolso
 * precisa exatamente do mesmo nucleo. Nao e estetica — o invariante monetario
 * vive no `where`, e o COMPILADOR nao le `where`. Duas copias divergiriam em
 * silencio, e a divergencia aqui e dinheiro contabilizado duas vezes.
 *
 * CAS sobre o VALOR, e nao sobre o status: `CAPTURED` e terminal e nao muda
 * (decisao 9 da fase — reembolso e aritmetica, nao transicao). O `base` e o
 * valor que o chamador LEU; se ele mudou, outro reembolso entrou no meio e o
 * `count` volta zero.
 *
 * `false` NAO significa recusar. Perder o CAS pode ser um reembolso concorrente
 * de valor MENOR chegando primeiro — quem chama recarrega o estado e refaz a
 * decisao. Tratar como recusa deixaria o banco ABAIXO do total realmente
 * reembolsado (achado 4.1 do review do Bloco 4).
 *
 * O `CHECK` do banco (`refundedAmountCents <= capturedAmountCents`, migration
 * inicial) e rede de seguranca, NAO substituto disto: se o codigo dependesse
 * dele, um estouro viraria erro de constraint em vez de recusa de dominio.
 */
export interface EntradaDoReembolso {
  paymentId: string;
  /** Total reembolsado que o chamador LEU. Condicao do compare-and-swap. */
  base: number;
  /** Novo total. A linha da trilha registra `total - base`. */
  total: number;
  providerRef: string;
}

export async function aplicarTotalDeReembolso(
  tx: Prisma.TransactionClient,
  entrada: EntradaDoReembolso,
): Promise<boolean> {
  const { count } = await tx.payment.updateMany({
    where: { id: entrada.paymentId, refundedAmountCents: entrada.base },
    data: { refundedAmountCents: entrada.total },
  });
  if (count === 0) return false;

  // A trilha registra ESTA movimentacao, nao o acumulado: o acumulado ja esta
  // no Payment, e somar as linhas tem de dar o mesmo numero.
  await tx.paymentTransaction.create({
    data: {
      paymentId: entrada.paymentId,
      type: TransactionType.REFUND,
      status: TransactionStatus.SUCCEEDED,
      amountCents: entrada.total - entrada.base,
      providerRef: entrada.providerRef,
    },
  });

  return true;
}
