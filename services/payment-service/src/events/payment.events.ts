import type { Prisma } from '@prisma/client';
import type { OutboxInput } from './outbox.repository';
import { ROUTING_PAYMENT_CAPTURED, eventIdDeCaptura } from './topology';

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
