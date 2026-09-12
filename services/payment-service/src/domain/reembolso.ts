import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { enqueue } from '../events/outbox.repository';
import { montarEventoDeReembolso } from '../events/payment.events';

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
  /**
   * O pagamento, e nao so o id: o evento precisa de orderId, currency e do
   * capturado. Tipo estrutural estreito documenta o que o evento consome e
   * dispensa fabricar um modelo inteiro nos testes.
   */
  payment: { id: string; orderId: string; currency: string; capturedAmountCents: number };
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
    where: { id: entrada.payment.id, refundedAmountCents: entrada.base },
    data: { refundedAmountCents: entrada.total },
  });
  if (count === 0) return false;

  // A trilha registra ESTA movimentacao, nao o acumulado: o acumulado ja esta
  // no Payment, e somar as linhas tem de dar o mesmo numero.
  await tx.paymentTransaction.create({
    data: {
      paymentId: entrada.payment.id,
      type: TransactionType.REFUND,
      status: TransactionStatus.SUCCEEDED,
      amountCents: entrada.total - entrada.base,
      providerRef: entrada.providerRef,
    },
  });

  // Evento na MESMA transacao do efeito — e AQUI, nao nos chamadores. Os dois
  // caminhos podem aplicar o estorno, mas o indice unico parcial garante que
  // so UM vence. Emitir no helper da exatamente um evento por estorno
  // contabilizado, quem quer que tenha ganho a corrida. Emitir nos dois
  // chamadores exigiria coordena-los — e coordenar dois escritores foi o
  // defeito que o Bloco 7 inteiro corrigiu.
  await enqueue(
    tx,
    montarEventoDeReembolso(
      {
        paymentId: entrada.payment.id,
        orderId: entrada.payment.orderId,
        currency: entrada.payment.currency,
        capturedAmountCents: entrada.payment.capturedAmountCents,
        refundedAmountCents: entrada.total,
        refundAmountCents: entrada.total - entrada.base,
        providerRefundRef: entrada.providerRef,
      },
      new Date(),
    ),
  );

  return true;
}

/** Desfechos possiveis de um reembolso INICIADO por nos (Bloco 7). */
export type DesfechoDeReembolso =
  | { tipo: 'aplicado'; totalReembolsadoCents: number; providerRefundRef: string }
  /** Aceite assincrono: o total so se move quando o webhook confirmar. */
  | { tipo: 'pendente'; providerRefundRef: string }
  | { tipo: 'recusado'; declineCode: string }
  | { tipo: 'valor-invalido' }
  | { tipo: 'estado-invalido'; status: string }
  | { tipo: 'excede-o-capturado'; capturadoCents: number; reembolsadoCents: number }
  /** Dinheiro voltou no provedor e a contabilidade local nao comporta. */
  | { tipo: 'divergencia'; capturadoCents: number; reembolsadoCents: number }
  /** CAS perdido acima do teto. Dinheiro movido, total pendente de reconciliacao. */
  | { tipo: 'contencao' };

/** Entrada do reembolso idempotente (Bloco 7). */
export interface ReembolsarInput {
  userId: string;
  idempotencyKey: string;
  paymentId: string;
  valorCents: number;
}

/**
 * O desfecho, mais a marca de replay.
 *
 * `replay` distingue "houve efeito novo" de "esta e a resposta congelada da
 * mesma chave" — o cliente decide sem interpretar o corpo, igual ao endpoint de
 * criacao. Intersecao, e nao campo em cada variante, para a uniao continuar
 * discriminada por `tipo`.
 */
export type ResultadoDeReembolso = DesfechoDeReembolso & { replay?: boolean };
