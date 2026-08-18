/**
 * Erros de dominio do payment-service.
 *
 * Um tipo com CODIGO, e nao uma classe por caso, porque o controller mapeia
 * codigo -> status HTTP numa tabela unica. Mesmo padrao do order-service.
 *
 * O codigo e contrato com o cliente HTTP; a mensagem e para humano e pode mudar.
 */

export type CodigoDeErroDePagamento =
  /** Outra requisicao com a mesma Idempotency-Key esta em andamento. */
  | 'IDEMPOTENCIA_EM_ANDAMENTO'
  /** A mesma Idempotency-Key ja foi usada numa requisicao que falhou. */
  | 'IDEMPOTENCIA_JA_FALHOU'
  /**
   * A mesma Idempotency-Key foi reusada para uma requisicao DIFERENTE.
   *
   * Distinto de IDEMPOTENCIA_JA_FALHOU: la a requisicao era a mesma e o
   * resultado foi ruim; aqui a chave esta sendo aplicada a outro pedido, o que
   * quebraria a idempotencia devolvendo o pagamento errado.
   */
  | 'IDEMPOTENCIA_CONFLITANTE'
  /** O pedido nao existe OU nao pertence ao usuario — indistinguivel. */
  | 'PEDIDO_NAO_ENCONTRADO'
  /** O pedido nao esta em estado que aceite cobranca. */
  | 'PEDIDO_NAO_COBRAVEL'
  /** Divergencia entre o total do pedido e a soma dos subtotais. */
  | 'VALOR_DO_PEDIDO_INVALIDO'
  /** Ja existe pagamento capturado para este pedido. */
  | 'PEDIDO_JA_PAGO'
  /** Ha uma tentativa em voo para este pedido. */
  | 'TENTATIVA_EM_ANDAMENTO'
  /** A janela de retentativa expirou. */
  | 'JANELA_EXPIRADA'
  /** Token ausente, invalido ou expirado. */
  | 'NAO_AUTORIZADO'
  /** Falha transiente do provedor ou do order-service. */
  | 'DEPENDENCIA_INDISPONIVEL'
  /** Requisicao malformada. */
  | 'REQUISICAO_INVALIDA';

export class PaymentDomainError extends Error {
  constructor(
    readonly code: CodigoDeErroDePagamento,
    message: string,
    /** Falha transiente: o cliente pode repetir com a MESMA chave. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PaymentDomainError';
  }
}

export function erroDeDominio(
  code: CodigoDeErroDePagamento,
  message: string,
  retryable = false,
): PaymentDomainError {
  return new PaymentDomainError(code, message, retryable);
}
