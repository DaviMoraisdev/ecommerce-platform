import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { CapturaEvent } from '../events/payment-events';
import { ResultadoAplicacao } from '../events/payments.consumer';
import { BINDING_PAYMENT_CAPTURED } from '../events/payments.topology';
import { aplicarTransicao } from './order.service';

// Autoria FIXA. O comentario do normalizeChangedBy exige identidade vinda do
// contexto do chamador, nunca do payload — aceitar changedBy da mensagem
// deixaria quem publica no exchange escolher quem assina a auditoria.
const AUTOR = 'payment-service';

// O order nao tem coluna de moeda: todo total e em BRL por construcao. Evento
// em outra moeda comparado numericamente com o total marcaria como pago um
// valor que nao corresponde.
const MOEDA = 'BRL';

/**
 * Erro de controle: desfecho legitimo que NAO deve deixar rastro.
 *
 * O invariante do inbox e "linha existe se e somente se o efeito aconteceu".
 * Como o insert do inbox e a primeira coisa da transacao, os desfechos sem
 * efeito precisam DESFAZER a transacao — e a unica forma de abortar uma
 * $transaction interativa e lancar. Commitar a marca de um evento que nao
 * produziu efeito faria a redentrega ser lida como duplicata: o mesmo buraco do
 * claim em armazenamento separado, dentro de um banco so.
 */
class SemEfeito extends Error {
  constructor(readonly resultado: ResultadoAplicacao) {
    super('desfecho sem efeito');
  }
}

// P2002 nao e uma coisa so: pode vir do @unique do inbox (duplicata de verdade)
// ou do unique parcial de pending_compensations (corrida). O formato do
// meta.target varia entre array de campos e nome de indice, entao normalizamos.
function alvoDoP2002(err: Prisma.PrismaClientKnownRequestError): string {
  const alvo = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(alvo)) return alvo.join(',');
  return typeof alvo === 'string' ? alvo : '';
}

export async function aplicarCaptura(ev: CapturaEvent): Promise<ResultadoAplicacao> {
  try {
    return await prisma.$transaction(async (tx): Promise<ResultadoAplicacao> => {
      // A marca ANTES do efeito, no mesmo commit. Se o efeito falhar, ela
      // desaparece junto; se ela colidir, o efeito nao acontece.
      await tx.inboxEvent.create({
        data: {
          eventId: ev.eventId,
          routingKey: BINDING_PAYMENT_CAPTURED,
          orderId: ev.orderId,
          paymentId: ev.paymentId,
          amountCents: ev.capturedAmountCents,
          currency: ev.currency,
        },
      });

      const order = await tx.order.findUnique({ where: { id: ev.orderId } });
      if (order === null) throw new SemEfeito({ tipo: 'pedido-inexistente' });

      // total e Decimal(12,2) em reais; o evento traz centavos inteiros.
      // Aritmetica do Decimal, nao Number(total) * 100: ponto flutuante
      // transformaria divergencia de contrato em bug intermitente de teste.
      if (ev.currency !== MOEDA) {
        throw new SemEfeito({ tipo: 'moeda-divergente', esperada: MOEDA, recebida: ev.currency });
      }

      // Captura parcial nao e suportada: o pedido so tem PAGO ou nao-PAGO, e
      // aceitar parcial levaria a PAGO com dinheiro faltando.
      if (ev.amountCents !== ev.capturedAmountCents) {
        throw new SemEfeito({
          tipo: 'captura-parcial',
          autorizadoCents: ev.amountCents,
          capturadoCents: ev.capturedAmountCents,
        });
      }

      const esperadoCents = order.total.mul(100).toNumber();
      if (esperadoCents !== ev.capturedAmountCents) {
        throw new SemEfeito({
          tipo: 'valor-divergente',
          esperadoCents,
          recebidoCents: ev.capturedAmountCents,
        });
      }

      if (order.status !== OrderStatus.PENDENTE) {
        // Qualquer estado diferente de PENDENTE significa que este e OUTRO
        // pagamento (o mesmo teria colidido no @unique do inbox). Segunda
        // cobranca real: registra para reconciliacao em vez de confirmar em
        // silencio. O detalhe de cada captura fica nas linhas do inbox,
        // buscaveis por orderId.
        const motivo =
          order.status === OrderStatus.CANCELADO
            ? 'captura_apos_cancelamento:' + ev.paymentId
            : 'captura_para_pedido_' + order.status.toLowerCase() + ':' + ev.paymentId;
        // findFirst antes de criar, em vez de create-e-trata-P2002: em Postgres
        // um erro DENTRO da transacao a envenena, e o catch daria a ilusao de
        // ter tratado enquanto o proximo statement falharia.
        const aberta = await tx.pendingCompensation.findFirst({
          where: { orderId: ev.orderId, resolvedAt: null },
        });
        if (aberta === null) {
          await tx.pendingCompensation.create({ data: { orderId: ev.orderId, reason: motivo } });
        }
        return { tipo: 'compensacao-registrada', motivo };
      }

      await aplicarTransicao(tx, ev.orderId, OrderStatus.PAGO, AUTOR);
      return { tipo: 'aplicado' };
    });
  } catch (err) {
    if (err instanceof SemEfeito) return err.resultado;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const alvo = alvoDoP2002(err);
      // SO o inbox vira duplicata. Colisao do unique parcial da compensacao e
      // corrida: abortou o inbox junto, entao precisa reprocessar (requeue).
      // P2002 desconhecido cai no lado conservador: relanca.
      // Alvo EXATO, nao includes: outro indice cujo nome contenha "inbox_events"
      // ou outro campo terminado em "eventId" viraria falso positivo, e a
      // mensagem receberia ack como duplicata com a transacao revertida.
      if (alvo === 'eventId' || alvo === 'inbox_events_eventId_key') {
        return { tipo: 'duplicata' };
      }
    }
    // Qualquer outra falha sobe: quem decide requeue e a camada de cima.
    throw err;
  }
}
