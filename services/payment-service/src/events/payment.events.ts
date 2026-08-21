import type { Payment } from '@prisma/client';
import type { OutboxInput } from './outbox.repository';

/**
 * Contrato do evento que ATRAVESSA A REDE e fica parado numa fila.
 *
 * Minimo e explicito: nada do payload do provedor entra aqui. O Bloco 4 gastou
 * seis rodadas de review provando que dado desconhecido nao pode ir para
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

/** STUB do Bloco 5a. `agora` e injetado para o teste nao depender do relogio. */
export function montarEventoDeCaptura(payment: Payment, agora: Date): OutboxInput {
  void payment;
  void agora;
  throw new Error('montarEventoDeCaptura: nao implementado (Bloco 5a)');
}
