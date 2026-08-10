import type { Currency } from '../domain/money';

/**
 * PORTA do provedor de pagamento.
 *
 * O vocabulario aqui e NOSSO, nao do provedor. Se algum campo se chamar
 * payment_intent_id, client_secret ou charge_id, a abstracao vazou: sao termos
 * da Stripe. O adapter e o unico lugar do servico que conhece o provedor real;
 * ele traduz para os tipos abaixo (camada anticorrupcao).
 *
 * Os desfechos sao UNIOES DISCRIMINADAS: combinacao impossivel nao compila.
 * Um adapter nao consegue devolver DECLINED sem declineCode, nem SUCCEEDED com
 * campo de recusa. Invariante no tipo vale mais que invariante em comentario.
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

/** Lista em runtime, para validar entrada estrangeira. Derivada do tipo abaixo. */
export const CHARGE_STATES = ['PROCESSING', 'SUCCEEDED', 'DECLINED', 'CANCELED'] as const;

/** createCharge nunca devolve CANCELED — cancelar exige pedido explicito. */
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
   *
   * CONTRATO: replay com a MESMA chave e os MESMOS parametros devolve a
   * resposta ORIGINAL, imutavel, independente do estado atual da cobranca.
   * Com parametros DIFERENTES, e erro — reusar chave para outra cobranca e bug
   * do chamador, e devolver a anterior esconderia o problema.
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
 *
 * Uniao discriminada por `state`: capturedAmountCents e literal 0 onde nada foi
 * capturado, e declineCode e OBRIGATORIO em DECLINED.
 */
export type ChargeResult =
  | {
      providerRef: ProviderRef;
      state: 'SUCCEEDED';
      capturedAmountCents: number;
    }
  | {
      providerRef: ProviderRef;
      state: 'PROCESSING';
      capturedAmountCents: 0;
    }
  | {
      providerRef: ProviderRef;
      state: 'DECLINED';
      capturedAmountCents: 0;
      /** Recusa e resultado de negocio — e sempre vem com codigo. */
      declineCode: string;
      declineMessage?: string;
    };

// ============================================================
// Consultar (reconciliacao, Bloco 6)
// ============================================================

/**
 * Retrato do que o provedor — fonte da verdade — diz sobre a cobranca agora.
 *
 * PLANO de proposito, ao contrario de ChargeResult. Snapshot e ESTADO, nao
 * desfecho: uma cobranca cancelada continua tendo amountCents, e valores
 * capturado e reembolsado coexistem. Apenas declineCode e condicional.
 */
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
  /** Mesmo contrato de replay do createCharge. */
  idempotencyKey: string;
}

// ============================================================
// Reembolsar (Bloco 7)
// ============================================================

export interface RefundInput {
  providerRef: ProviderRef;
  amountCents: number;
  /** Mesmo contrato de replay do createCharge. */
  idempotencyKey: string;
}

export type RefundResult =
  | { providerRefundRef: string; state: 'SUCCEEDED'; amountCents: number }
  | { providerRefundRef: string; state: 'PROCESSING'; amountCents: number }
  | { providerRefundRef: string; state: 'DECLINED'; amountCents: number; declineCode: string };

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

interface WebhookEventBase {
  /** Id do evento NO PROVEDOR. Base do unique(provider, providerEventId). */
  providerEventId: string;
  providerRef: ProviderRef;

  /**
   * Quando o PROVEDOR gerou o evento. Null quando ele nao informa.
   * Politica fail-closed do Bloco 4: null nao altera estado de pagamento.
   */
  providerCreatedAt: Date | null;

  /** Payload original, gravado no inbox para auditoria e reprocessamento. */
  raw: unknown;
}

/**
 * Uniao discriminada por eventType. Cada variante carrega SOMENTE os campos que
 * fazem sentido para ela — o handler do Bloco 4 e obrigado a estreitar antes de
 * tocar em valor financeiro.
 *
 * `unsupported` NAO carrega estado nem valores: nao conhecemos a semantica de um
 * evento que nao tratamos, e o tipo impede o handler de usar dado que nao sabe
 * interpretar.
 */
export type WebhookEventPayload =
  | (WebhookEventBase & {
      eventType: 'payment.succeeded';
      state: 'SUCCEEDED';
      capturedAmountCents: number;
      refundedAmountCents: number;
    })
  | (WebhookEventBase & {
      eventType: 'payment.failed';
      state: 'DECLINED';
      declineCode?: string;
    })
  | (WebhookEventBase & {
      eventType: 'payment.canceled';
      state: 'CANCELED';
    })
  | (WebhookEventBase & {
      eventType: 'refund.succeeded';
      state: 'SUCCEEDED';
      capturedAmountCents: number;
      refundedAmountCents: number;
    })
  | (WebhookEventBase & {
      eventType: 'unsupported';
    });

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

/**
 * Requisicao malformada, token invalido, ou payload de webhook que passou a
 * assinatura mas nao a validacao semantica. Nao retentar.
 */
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
   *
   * Lanca WebhookSignatureError quando a assinatura, o timestamp ou o relogio
   * nao permitem confiar na origem; lanca ProviderInvalidRequestError quando a
   * origem e confiavel mas o CONTEUDO e invalido. Assinatura valida prova
   * autenticidade dos bytes, nao validade semantica.
   */
  verifyWebhook(request: WebhookRequest): WebhookEventPayload;
}
