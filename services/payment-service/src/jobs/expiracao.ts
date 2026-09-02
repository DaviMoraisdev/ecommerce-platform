/**
 * EXPIRACAO DA JANELA (Bloco 6e).
 *
 * Populacao COMPLEMENTAR a da reconciliacao (6b): la, `providerRef` NULO
 * significa "chamamos o provedor e nao sabemos o que aconteceu". Aqui,
 * `providerRef` PRESENTE significa "a cobranca existe e o provedor nunca
 * concluiu". A primeira se resolve PERGUNTANDO; esta, COMANDANDO o
 * cancelamento.
 *
 * A decisao pura e a varredura entram no incremento 2.
 */

/** Uma tentativa cuja cobranca existe e passou da janela. */
export interface TentativaExpirando {
  id: string;
  paymentId: string;
  attemptCount: number;
  /**
   * Nao-nulo por construcao do WHERE. Tipo proprio em vez de campo opcional em
   * `TentativaPresa`: opcional obrigaria checagem de null em runtime para algo
   * que a consulta ja garante, e checagem redundante ensina a proxima pessoa
   * que o campo pode faltar.
   */
  providerRef: string;
  /** Compoe o cursor da paginacao junto com o `id`. */
  createdAt: Date;
}
