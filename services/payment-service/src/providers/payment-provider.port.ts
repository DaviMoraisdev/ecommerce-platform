import type { Currency } from '../domain/money';

/**
 * PORTA do provedor de pagamento.
 *
 * O vocabulario aqui e NOSSO, nao do provedor. Se algum campo se chamar
 * payment_intent_id, client_secret ou charge_id, a abstracao vazou: sao termos
 * da Stripe. O adapter e o unico lugar do servico que conhece o provedor real;
 * ele traduz para os tipos abaixo (camada anticorrupcao).
 */

// ============================================================
// Identidade
// ============================================================

/** Vai gravado em Payment.provider. */
export type ProviderName = 'fake' | 'stripe';

/** Referencia da cobranca no provedor. Opaca para nos — nunca interpretada. */
export type ProviderRef = string;

// ============================================================
// Estados
// ============================================================

/**
 * Estado da cobranca do ponto de vista do PROVEDOR.
 * Mapeamento para o nosso PaymentStatus e responsabilidade do servico:
 *   PROCESSING -> PROCESSING   SUCCEEDED -> CAPTURED
 *   DECLINED   -> FAILED       CANCELED  -> CANCELED
 */
export type ChargeState = 'PROCESSING' | 'SUCCEEDED' | 'DECLINED' | 'CANCELED';

/**
 * createCharge nunca devolve CANCELED — cancelamento exige um pedido explicito.
 * Extract restringe a uniao no tipo, entao o compilador impede o adapter de
 * devolver um estado impossivel.
 */
export type CreateChargeState = Extract<ChargeState, 'PROCESSING' | 'SUCCEEDED' | 'DECLINED'>;

// ============================================================
// Criar cobranca
// ============================================================

export interface CreateChargeInput {
  amountCents: number;
  currency: Currency;

  /**
   * Token do meio de pagamento, gerado NO CLIENTE pelo provedor.
   *
   * PCI-DSS: o numero do cartao (PAN), CVV e validade nunca passam por este
   * servico. O navegador envia direto ao provedor e recebe este token de volta.
   * Aceitar PAN aqui jogaria o projeto no escopo mais caro de auditoria PCI.
   */
  paymentMethodToken: string;

  /**
   * Idempotencia DO PROVEDOR — camada distinta da nossa.
   * A nossa (Idempotency-Key no Bloco 3) protege o nosso banco. Esta protege o
   * dinheiro: se a chamada HTTP der timeout e retentarmos, a primeira pode ter
   * chegado, e sem esta chave o cliente seria cobrado duas vezes.
   */
  idempotencyKey: string;

  /** Correlacao para reconciliacao e triagem. Nunca usada como segredo. */
  reference: {
    paymentId: string;
    orderId: string;
  };
}

/**
 * Resultado IMEDIATO da chamada. A confirmacao definitiva chega por webhook —
 * este retorno diz apenas o que o provedor sabia no instante da resposta.
 */
export interface ChargeResult {
  providerRef: ProviderRef;
  state: CreateChargeState;

  /** 0 enquanto nao houver captura confirmada. */
  capturedAmountCents: number;

  /**
   * Preenchidos SOMENTE quando state === 'DECLINED'.
   * Recusa e resultado de negocio, nao excecao — ver a secao de erros abaixo.
   */
  declineCode?: string;
  declineMessage?: string;
}

// ============================================================
// Consultar (reconciliacao, Bloco 6)
// ============================================================

/** Retrato do que o provedor — fonte da verdade — diz sobre a cobranca agora. */
export interface ChargeSnapshot {
  providerRef: ProviderRef;
  state: ChargeState;
  amountCents: number;
  capturedAmountCents: number;
  refundedAmountCents: number;
  declineCode?: string;
}

// ============================================================
// Cancelar (expiracao da janela, Bloco 6)
// ============================================================

export interface CancelChargeInput {
  providerRef: ProviderRef;
  idempotencyKey: string;
}

// ============================================================
// Reembolsar (Bloco 7)
// ============================================================

export interface RefundInput {
  providerRef: ProviderRef;
  amountCents: number;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundRef: string;
  state: 'PROCESSING' | 'SUCCEEDED' | 'DECLINED';
  amountCents: number;
}

// ============================================================
// Webhook (Bloco 4)
// ============================================================

export interface WebhookRequest {
  /**
   * Corpo CRU, como chegou. Buffer, nao objeto.
   * A assinatura HMAC e calculada sobre os bytes exatos: se express.json() ja
   * tiver parseado e reserializado, a verificacao falha para sempre. E a
   * armadilha numero um de integracao de webhook.
   */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/** Tipos de evento no NOSSO vocabulario. */
export type PaymentEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.canceled'
  | 'refund.succeeded'
  /** Evento que o provedor manda e nos nao tratamos -> inbox com status IGNORED. */
  | 'unsupported';

export interface WebhookEventPayload {
  /** Id do evento NO PROVEDOR. Base do unique(provider, providerEventId). */
  providerEventId: string;
  eventType: PaymentEventType;
  providerRef: ProviderRef;

  /**
   * Quando o PROVEDOR gerou o evento. Null quando ele nao informa.
   * Politica fail-closed do Bloco 4: null nao altera estado de pagamento.
   */
  providerCreatedAt: Date | null;

  state: ChargeState;
  capturedAmountCents: number;
  refundedAmountCents: number;
  declineCode?: string;

  /** Payload original, gravado no inbox para auditoria e reprocessamento. */
  raw: unknown;
}

// ============================================================
// Erros
// ============================================================

/**
 * IMPORTANTE: nao existe erro de "cartao recusado".
 * Recusa e um RESULTADO (state: 'DECLINED'), porque e desfecho normal de
 * negocio: vira PaymentTransaction FAILED e o cliente pode tentar outro cartao.
 * Tratar recusa como excecao polui log de erro e torna a janela de retentativa
 * impossivel de modelar.
 *
 * As classes abaixo sao falhas TECNICAS. `retryable` e dado no erro, e nao
 * inferido de string: error.name e mutavel, e comparar mensagem quebra na
 * primeira mudanca de texto do provedor.
 */
export abstract class PaymentProviderError extends Error {
  abstract readonly retryable: boolean;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Rede, timeout, 5xx do provedor. Transiente — retentar com backoff. */
export class ProviderUnavailableError extends PaymentProviderError {
  readonly retryable = true;
}

/** Requisicao malformada ou token invalido. Bug nosso — nao retentar. */
export class ProviderInvalidRequestError extends PaymentProviderError {
  readonly retryable = false;
}

/** Credencial do provedor invalida. Problema de configuracao — nao retentar. */
export class ProviderAuthenticationError extends PaymentProviderError {
  readonly retryable = false;
}

/** providerRef desconhecido pelo provedor. Nao retentar; investigar. */
export class ChargeNotFoundError extends PaymentProviderError {
  readonly retryable = false;
}

/** Assinatura ausente, invalida ou fora da janela de tolerancia. */
export class WebhookSignatureError extends PaymentProviderError {
  readonly retryable = false;
}

// ============================================================
// A porta
// ============================================================

export interface PaymentProvider {
  readonly name: ProviderName;

  createCharge(input: CreateChargeInput): Promise<ChargeResult>;

  getCharge(providerRef: ProviderRef): Promise<ChargeSnapshot>;

  cancelCharge(input: CancelChargeInput): Promise<ChargeSnapshot>;

  refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Sincrono de proposito: verificacao de assinatura e criptografia pura, sem
   * I/O. Torna o handler do webhook mais simples e o teste trivial.
   * Lanca WebhookSignatureError quando a assinatura nao confere.
   */
  verifyWebhook(request: WebhookRequest): WebhookEventPayload;
}
