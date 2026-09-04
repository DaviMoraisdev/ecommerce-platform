import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { ExpiracaoEvent } from '../events/payment-events';
import { ResultadoAplicacao } from '../events/payments.consumer';
import { BINDING_PAYMENT_EXPIRED } from '../events/payments.topology';
import { SemEfeito, alvoDoP2002 } from './inbox-efeito';
import { aplicarTransicao, liberarReservaAposCancelamento } from './order.service';

// Mesma autoria fixa da captura: identidade vem do contexto, nunca do payload.
const AUTOR = 'payment-service';
const MOEDA = 'BRL';

/**
 * Compensacao da saga quando a janela de pagamento expira (Bloco 6f).
 *
 * O pagamento chegou a EXPIRED no payment-service, que ja CANCELOU a cobranca
 * no provedor. Aqui o pedido precisa sair de PENDENTE e o estoque reservado
 * precisa voltar — sem isso o pedido fica pendurado para sempre, que e o estado
 * que o Bloco 6 inteiro existe para eliminar.
 *
 * A REGRA DE SEGURANCA do bloco: pedido PAGO NUNCA e cancelado por expiracao.
 * A matriz de estados PERMITE PAGO -> CANCELADO (cancelamento e operacao
 * legitima), entao a protecao tem de ser explicita aqui. Um payment.expired
 * sobre pedido pago e contradicao — dinheiro cobrado e pagamento expirado nao
 * coexistem — e cancelar liberaria estoque de um pedido que foi pago.
 */
export async function aplicarExpiracao(ev: ExpiracaoEvent): Promise<ResultadoAplicacao> {
  let resultado: ResultadoAplicacao;

  try {
    resultado = await prisma.$transaction(async (tx): Promise<ResultadoAplicacao> => {
      // A marca ANTES do efeito, no mesmo commit — invariante do inbox.
      await tx.inboxEvent.create({
        data: {
          eventId: ev.eventId,
          routingKey: BINDING_PAYMENT_EXPIRED,
          orderId: ev.orderId,
          paymentId: ev.paymentId,
          amountCents: ev.amountCents,
          currency: ev.currency,
        },
      });

      const order = await tx.order.findUnique({ where: { id: ev.orderId } });
      if (order === null) throw new SemEfeito({ tipo: 'pedido-inexistente' });

      if (ev.currency !== MOEDA) {
        throw new SemEfeito({ tipo: 'moeda-divergente', esperada: MOEDA, recebida: ev.currency });
      }

      // Cancelar e DESTRUTIVO: libera estoque. Um evento cujo valor nao bate com
      // o pedido pode ser de outro pedido, e agir nele seria pior que nao agir.
      const esperadoCents = order.total.mul(100).toNumber();
      if (esperadoCents !== ev.amountCents) {
        throw new SemEfeito({
          tipo: 'valor-divergente',
          esperadoCents,
          recebidoCents: ev.amountCents,
        });
      }

      if (order.status === OrderStatus.CANCELADO) {
        // Efeito desejado JA existe, por outro caminho. Sem efeito proprio, a
        // marca do inbox nao pode ficar: senao a reentrega leria como duplicata
        // um evento que nunca produziu nada.
        throw new SemEfeito({ tipo: 'ja-cancelado' });
      }

      if (order.status !== OrderStatus.PENDENTE) {
        // PAGO, ENVIADO ou ENTREGUE. Contradicao real: registra para triagem
        // humana e NAO toca no pedido.
        const motivo = 'expiracao_para_pedido_' + order.status.toLowerCase() + ':' + ev.paymentId;
        const aberta = await tx.pendingCompensation.findFirst({
          where: { orderId: ev.orderId, resolvedAt: null },
        });
        if (aberta === null) {
          await tx.pendingCompensation.create({ data: { orderId: ev.orderId, reason: motivo } });
        }
        return { tipo: 'compensacao-registrada', motivo };
      }

      await aplicarTransicao(tx, ev.orderId, OrderStatus.CANCELADO, AUTOR);
      return { tipo: 'aplicado' };
    });
  } catch (err) {
    if (err instanceof SemEfeito) return err.resultado;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const alvo = alvoDoP2002(err);
      if (alvo === 'eventId' || alvo === 'inbox_events_eventId_key') {
        return { tipo: 'duplicata' };
      }
    }
    throw err;
  }

  // FORA da transacao, de propósito: e chamada HTTP ao inventory. Dentro dela
  // seguraria locks, e um rollback posterior deixaria o estoque liberado sem o
  // cancelamento. Falha vira pendencia DURAVEL, e por isso quem chama pode dar
  // ack: repetir a mensagem nao melhora nada e o cancelamento ja aconteceu.
  if (resultado.tipo === 'aplicado') {
    await liberarReservaAposCancelamento(ev.orderId);
  }

  return resultado;
}
