import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { ReembolsoEvent } from '../events/payment-events';
import { ResultadoAplicacao } from '../events/payments.consumer';
import { BINDING_PAYMENT_REFUNDED } from '../events/payments.topology';
import { SemEfeito, alvoDoP2002 } from './inbox-efeito';
import {
  MOTIVO_LIBERACAO_PENDENTE,
  aplicarTransicao,
  concluirLiberacao,
  registrarPendencia,
} from './order.service';

const AUTOR = 'payment-service';
const MOEDA = 'BRL';

/**
 * Representacao do estorno no pedido (Bloco 7b).
 *
 * Duas coisas, com regras DIFERENTES:
 *
 * 1. O VALOR se move sempre. `refundedTotal` e aritmetica, nao fase — mesma
 *    decisao que mantem o pagamento em CAPTURED no payment-service.
 * 2. A TRANSICAO acontece so no estorno INTEGRAL e so a partir de PAGO.
 *
 * Estorno integral de pedido PAGO tambem LIBERA a reserva: o dinheiro voltou
 * inteiro e a mercadoria nunca saiu, entao segurar estoque deixaria o pedido
 * pendurado — a classe de bug que o Bloco 6 existiu para eliminar. ENVIADO e
 * ENTREGUE nao liberam nada: a mercadoria saiu, e devolver unidade ao estoque
 * sem ela ter voltado fisicamente e inventar inventario.
 */
/**
 * Desfecho INTERNO. `liberar` e explicito porque nao da para inferi-lo do
 * resultado publico: `aplicado` sai de TRES caminhos — estorno parcial, no-op
 * monotonico e transicao integral — e so o ultimo tem reserva a devolver.
 *
 * `concluirLiberacao` chama o inventory INCONDICIONALMENTE e so depois resolve
 * a pendencia. Gatear pelo resultado publico liberaria estoque em TODO estorno
 * parcial: pedido ainda PAGO, mercadoria a expedir, reserva devolvida.
 */
interface Desfecho {
  publico: ResultadoAplicacao;
  liberar: boolean;
}

export async function aplicarReembolso(ev: ReembolsoEvent): Promise<ResultadoAplicacao> {
  let desfecho: Desfecho;

  try {
    desfecho = await prisma.$transaction(async (tx): Promise<Desfecho> => {
      // A marca ANTES do efeito, no mesmo commit — invariante do inbox.
      // `amountCents` recebe o DELTA: a linha do inbox registra o que ESTA
      // mensagem moveu, nao o acumulado, que vive no pedido.
      await tx.inboxEvent.create({
        data: {
          eventId: ev.eventId,
          routingKey: BINDING_PAYMENT_REFUNDED,
          orderId: ev.orderId,
          paymentId: ev.paymentId,
          amountCents: ev.refundAmountCents,
          currency: ev.currency,
        },
      });

      const order = await tx.order.findUnique({ where: { id: ev.orderId } });
      if (order === null) throw new SemEfeito({ tipo: 'pedido-inexistente' });

      if (ev.currency !== MOEDA) {
        throw new SemEfeito({ tipo: 'moeda-divergente', esperada: MOEDA, recebida: ev.currency });
      }

      // MESMA guarda do aplicarExpiracao, e pela mesma razao que o comentario
      // dele registra: um evento cujo valor nao bate com o pedido pode ser de
      // OUTRO pedido, e agir nele e pior que nao agir.
      //
      // Achado 3.1 da revisao. Eu usei aquele arquivo como molde e decidi NAO
      // copiar esta checagem, argumentando que a transicao era menos destrutiva
      // que o cancelamento. Errado: ela LIBERA ESTOQUE, que e exatamente o
      // efeito que a guarda protege la.
      const esperadoCents = order.total.mul(100).toNumber();
      if (esperadoCents !== ev.capturedAmountCents) {
        throw new SemEfeito({
          tipo: 'valor-divergente',
          esperadoCents,
          recebidoCents: ev.capturedAmountCents,
        });
      }

      // Atualizacao MONOTONICA, nao compare-and-swap sobre uma base lida.
      //
      // O evento carrega o total ACUMULADO, e o inbox ja impede reentrega do
      // MESMO evento. O que sobra e ordem de chegada entre eventos DIFERENTES:
      // dois estornos parciais podem chegar invertidos, e um total menor
      // aplicado depois DESFARIA um maior. `lt` torna a escrita monotonica —
      // total menor vira no-op em vez de regressao.
      //
      // Centavos -> Decimal(12,2) e conversao EXATA: inteiro dividido por 100
      // com duas casas nao arredonda.
      const alvo = new Prisma.Decimal(ev.refundedAmountCents).div(100);
      const { count } = await tx.order.updateMany({
        where: { id: ev.orderId, refundedTotal: { lt: alvo } },
        data: { refundedTotal: alvo },
      });

      // `count === 0` NAO e falha: significa que o acumulado ja registrado e
      // maior ou igual ao deste evento. O estado desejado vale, entao o evento
      // foi processado — e a transicao, se cabia, ja veio com o evento maior.
      if (count === 0) return { publico: { tipo: 'aplicado' }, liberar: false };

      const integral = ev.refundedAmountCents >= ev.capturedAmountCents;
      if (!integral) return { publico: { tipo: 'aplicado' }, liberar: false };

      // Achado 4.3 da 3a rodada do review. O `order` acima foi lido ANTES da
      // escrita monetaria, e o `updateMany` nao condiciona em status: entre as
      // duas coisas uma captura concorrente pode ter commitado. Decidir o ramo
      // com a leitura antiga registra pendencia para um pedido que JA e PAGO —
      // dinheiro devolvido, sem transicao, e estoque preso ate triagem humana.
      //
      // A releitura e barata e e FRESCA: o `updateMany` acima ja tomou o lock
      // da linha, entao sob READ COMMITTED este SELECT enxerga tudo que
      // commitou antes dele. O caminho DESTRUTIVO ja estava protegido —
      // `aplicarTransicao` faz leitura e compare-and-swap proprios. O que nao
      // estava protegido era a ESCOLHA DO RAMO, que e o achado.
      const atual = await tx.order.findUniqueOrThrow({ where: { id: ev.orderId } });

      if (atual.status === OrderStatus.CANCELADO) {
        // Terminal por outro caminho. O valor se moveu acima; nao ha transicao
        // a fazer, e forcar REEMBOLSADO apagaria a razao real do fim do pedido.
        return { publico: { tipo: 'aplicado' }, liberar: false };
      }

      if (atual.status !== OrderStatus.PAGO) {
        // PENDENTE e contradicao (dinheiro estornado de pedido que nunca foi
        // pago). ENVIADO e ENTREGUE sao DEVOLUCAO: ha mercadoria na rua, e
        // logistica reversa nao e coisa que este servico saiba conduzir.
        // Registra para triagem humana e NAO toca no estado nem no estoque.
        const motivo =
          'estorno_integral_para_pedido_' + atual.status.toLowerCase() + ':' + ev.paymentId;
        await registrarPendencia(tx, ev.orderId, motivo);
        return { publico: { tipo: 'compensacao-registrada', motivo }, liberar: false };
      }

      await aplicarTransicao(tx, ev.orderId, OrderStatus.REEMBOLSADO, AUTOR);

      // INTENCAO DURAVEL da liberacao, no MESMO commit da transicao. Sem ela,
      // uma queda entre o commit e o release deixaria o pedido REEMBOLSADO com
      // estoque RESERVADO e nenhum rastro: a reentrega bate no @unique do inbox
      // e devolve duplicata antes de chegar ao release. Mesma licao do 6f.
      await registrarPendencia(tx, ev.orderId, MOTIVO_LIBERACAO_PENDENTE + ev.paymentId);
      return { publico: { tipo: 'aplicado' }, liberar: true };
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

  // FORA da transacao: e chamada HTTP ao inventory. Dentro dela seguraria
  // locks, e um rollback posterior deixaria o estoque liberado sem a transicao.
  //
  // Gateado por `liberar`, NAO pelo resultado publico: concluirLiberacao chama
  // o release incondicionalmente, entao inferir do desfecho devolveria estoque
  // a cada estorno parcial.
  if (desfecho.liberar) {
    await concluirLiberacao(ev.orderId);
  }

  return desfecho.publico;
}
