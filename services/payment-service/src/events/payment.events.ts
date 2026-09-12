import type { Prisma } from '@prisma/client';
import type { OutboxInput } from './outbox.repository';
import {
  ROUTING_PAYMENT_CAPTURED,
  ROUTING_PAYMENT_EXPIRED,
  ROUTING_PAYMENT_REFUNDED,
  eventIdDeCaptura,
  eventIdDeExpiracao,
  eventIdDeReembolso,
} from './topology';

/**
 * Entrada EXPLICITA, e nao o `Payment` inteiro.
 *
 * No handler do webhook o objeto em maos e o ANTERIOR ao compare-and-swap:
 * `capturedAmountCents` ainda vale 0 naquele ponto. Aceitar o `Payment` faria o
 * evento sair com o valor errado dependendo de quem chama lembrar de atualizar
 * o objeto antes. O tipo passa a exigir o valor confirmado.
 */
export interface CapturaConfirmada {
  paymentId: string;
  orderId: string;
  amountCents: number;
  /** Valor EFETIVAMENTE capturado, vindo do evento do provedor. */
  capturedAmountCents: number;
  currency: string;
}

/**
 * Contrato do que ATRAVESSA A REDE e fica parado numa fila.
 *
 * Minimo e fechado: nada do payload do provedor entra. O Bloco 4 gastou seis
 * rodadas de review provando que dado desconhecido nao pode ir para
 * armazenamento; numa mensagem em fila o risco e maior, nao menor.
 */
export interface PayloadDeCaptura {
  eventId: string;
  paymentId: string;
  orderId: string;
  amountCents: number;
  capturedAmountCents: number;
  currency: string;
  occurredAt: string;
}

export function montarEventoDeCaptura(captura: CapturaConfirmada, agora: Date): OutboxInput {
  const eventId = eventIdDeCaptura(captura.paymentId);
  const payload: PayloadDeCaptura = {
    eventId,
    paymentId: captura.paymentId,
    orderId: captura.orderId,
    amountCents: captura.amountCents,
    capturedAmountCents: captura.capturedAmountCents,
    currency: captura.currency,
    occurredAt: agora.toISOString(),
  };
  return {
    eventId,
    routingKey: ROUTING_PAYMENT_CAPTURED,
    payload: payload as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Entrada do evento de EXPIRACAO (Bloco 6f).
 *
 * NAO tem `capturedAmountCents`: nada foi capturado, e o campo existiria so
 * para ser zero. Campo que so pode ter um valor e ruido no contrato, e o
 * consumidor teria de decidir o que fazer com ele.
 */
export interface ExpiracaoConfirmada {
  paymentId: string;
  orderId: string;
  amountCents: number;
  currency: string;
}

/** Mesmo criterio do PayloadDeCaptura: minimo, fechado, nada do provedor. */
export interface PayloadDeExpiracao {
  eventId: string;
  paymentId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  occurredAt: string;
}

export function montarEventoDeExpiracao(
  expiracao: ExpiracaoConfirmada,
  agora: Date,
): OutboxInput {
  const eventId = eventIdDeExpiracao(expiracao.paymentId);

  const payload: PayloadDeExpiracao = {
    eventId,
    paymentId: expiracao.paymentId,
    orderId: expiracao.orderId,
    amountCents: expiracao.amountCents,
    currency: expiracao.currency,
    occurredAt: agora.toISOString(),
  };

  return {
    eventId,
    routingKey: ROUTING_PAYMENT_EXPIRED,
    payload: payload as unknown as Prisma.InputJsonValue,
  };
}


/**
 * Entrada do evento de REEMBOLSO (Bloco 7b).
 *
 * Carrega TRES numeros, e a redundancia e deliberada:
 *   - `capturedAmountCents`: base para o consumidor decidir se o estorno foi
 *     INTEGRAL. A regra de transicao e do pedido, entao mandamos os numeros e
 *     nao um booleano ja calculado — booleano derivado congela no payload a
 *     regra de quem o emitiu.
 *   - `refundedAmountCents`: total ACUMULADO. E o que o consumidor aplica por
 *     compare-and-swap, o que o torna idempotente sob reentrega e imune a
 *     ordem de chegada.
 *   - `refundAmountCents`: o delta DESTA movimentacao, para a trilha do pedido.
 *     Sem ele o consumidor calcularia o delta a partir do proprio estado, e uma
 *     reentrega fora de ordem produziria delta errado.
 */
export interface ReembolsoConfirmado {
  paymentId: string;
  orderId: string;
  currency: string;
  capturedAmountCents: number;
  refundedAmountCents: number;
  refundAmountCents: number;
  providerRefundRef: string;
}

/** Contrato que ATRAVESSA A REDE. Fechado, como os dois acima. */
export interface PayloadDeReembolso {
  eventId: string;
  paymentId: string;
  orderId: string;
  providerRefundRef: string;
  capturedAmountCents: number;
  refundedAmountCents: number;
  refundAmountCents: number;
  currency: string;
  occurredAt: string;
}

export function montarEventoDeReembolso(
  reembolso: ReembolsoConfirmado,
  agora: Date,
): OutboxInput {
  const eventId = eventIdDeReembolso(reembolso.providerRefundRef);

  const payload: PayloadDeReembolso = {
    eventId,
    paymentId: reembolso.paymentId,
    orderId: reembolso.orderId,
    providerRefundRef: reembolso.providerRefundRef,
    capturedAmountCents: reembolso.capturedAmountCents,
    refundedAmountCents: reembolso.refundedAmountCents,
    refundAmountCents: reembolso.refundAmountCents,
    currency: reembolso.currency,
    occurredAt: agora.toISOString(),
  };

  return {
    eventId,
    routingKey: ROUTING_PAYMENT_REFUNDED,
    payload: payload as unknown as Prisma.InputJsonValue,
  };
}