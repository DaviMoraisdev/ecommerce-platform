import Stripe from 'stripe';

import {
  ChargeNotCancelableError,
  ChargeNotFoundError,
  PaymentProviderError,
  ProviderAuthenticationError,
  ProviderInvalidRequestError,
  ProviderUnavailableError,
  RefundExceedsAvailableError,
  WebhookSignatureError,
} from '../payment-provider.port';

/**
 * Taxonomia: erro do SDK -> erro da PORTA.
 *
 * Vive em arquivo proprio, e nao no stripe.mapeamento.ts, porque precisa das
 * CLASSES em runtime para usar instanceof — o modulo de mapeamento importa so
 * tipos e fica sem dependencia de runtime.
 *
 * Decidir por CLASSE e por `code`, nunca por mensagem: e a regra que a propria
 * porta impoe ("error.name e mutavel, e comparar mensagem quebra na primeira
 * mudanca de texto do provedor"), e aqui os ramos decidem sobre DINHEIRO.
 */

/**
 * O MESMO `code` significa coisas diferentes por operacao:
 * `payment_intent_unexpected_state` ao cancelar e "ja capturou", que o job do
 * 6e le como INFORMACAO e nao como falha. Sem contexto eu teria de escolher um
 * significado e errar no outro ramo.
 */
export type ContextoDaChamada = 'criar' | 'consultar' | 'cancelar' | 'reembolsar' | 'webhook';

export const CODIGO_RECURSO_AUSENTE = 'resource_missing';
export const CODIGO_ESTADO_INESPERADO = 'payment_intent_unexpected_state';
export const CODIGO_JA_REEMBOLSADO = 'charge_already_refunded';

/**
 * Contextos em que a cobranca JA EXISTE quando chamamos. Fora deles,
 * resource_missing nao pode significar "cobranca inexistente": em criar, o
 * unico id que enviamos e o do metodo de pagamento.
 */
export const CONTEXTOS_COM_COBRANCA_EXISTENTE: ReadonlySet<ContextoDaChamada> = new Set([
  'consultar',
  'cancelar',
  'reembolsar',
]);

/**
 * Mensagem com CAMPOS FECHADOS, sem o texto do provedor.
 *
 * Mensagem de SDK pode carregar valor de parametro, e esta string e persistida
 * e logada. Tipo, codigo e status HTTP bastam para triagem e nao carregam
 * conteudo de requisicao. Fecha, para este caminho, a divida de sanitizacao
 * registrada no TECH_DEBT.
 */
function motivo(erro: Stripe.errors.StripeError, contexto: ContextoDaChamada): string {
  return (
    `falha da Stripe em ${contexto} ` +
    `(tipo ${erro.type}, codigo ${erro.code ?? 'ausente'}, http ${erro.statusCode ?? 'ausente'})`
  );
}

/**
 * SEMPRE lanca — por isso o retorno `never`, que deixa o compilador saber que o
 * fluxo nao continua depois da chamada.
 */
export function lancarTraduzido(erro: unknown, contexto: ContextoDaChamada): never {
  // Erro JA nosso passa reto: retraduzir perderia a classe original.
  if (erro instanceof PaymentProviderError) throw erro;

  if (erro instanceof Stripe.errors.StripeSignatureVerificationError) {
    throw new WebhookSignatureError('assinatura do webhook invalida');
  }

  // Transiente: retentar com backoff e o certo. E o UNICO ramo retryable.
  if (
    erro instanceof Stripe.errors.StripeConnectionError ||
    erro instanceof Stripe.errors.StripeAPIError ||
    erro instanceof Stripe.errors.StripeRateLimitError
  ) {
    throw new ProviderUnavailableError(motivo(erro, contexto));
  }

  // Configuracao, nao transiente: retentar nao conserta credencial.
  if (
    erro instanceof Stripe.errors.StripeAuthenticationError ||
    erro instanceof Stripe.errors.StripePermissionError
  ) {
    throw new ProviderAuthenticationError(motivo(erro, contexto));
  }

  // Chave reusada com outros parametros: bug do CHAMADOR. Retentar repete o bug.
  if (erro instanceof Stripe.errors.StripeIdempotencyError) {
    throw new ProviderInvalidRequestError(motivo(erro, contexto));
  }

  if (erro instanceof Stripe.errors.StripeInvalidRequestError) {
    if (erro.code === CODIGO_RECURSO_AUSENTE) {
      // O codigo nomeia o recurso que a REQUISICAO citou, nao necessariamente
      // uma cobranca. Generalizar isto entregaria aos jobos de reconciliacao
      // "cobranca ausente" como fato, fora dos contextos em que ela existe.
      if (CONTEXTOS_COM_COBRANCA_EXISTENTE.has(contexto)) {
        throw new ChargeNotFoundError(motivo(erro, contexto));
      }
      throw new ProviderInvalidRequestError(motivo(erro, contexto));
    }
    if (erro.code === CODIGO_ESTADO_INESPERADO && contexto === 'cancelar') {
      throw new ChargeNotCancelableError(motivo(erro, contexto));
    }
    if (erro.code === CODIGO_JA_REEMBOLSADO && contexto === 'reembolsar') {
      throw new RefundExceedsAvailableError(motivo(erro, contexto));
    }
    // NAO VERIFICADO: o codigo para "valor acima do nao reembolsado" pode vir
    // ausente, com a razao so na MENSAGEM. A porta proibe decidir por mensagem
    // em ramo de dinheiro, entao isto cai em requisicao invalida em vez de
    // afirmar RefundExceedsAvailable. Verificar no 9c, com reembolso acima do
    // saldo contra a API real.
    throw new ProviderInvalidRequestError(motivo(erro, contexto));
  }

  // Recusa de cartao FORA da criacao: a criacao trata card_error como
  // RESULTADO; em qualquer outra operacao ela e requisicao invalida.
  if (erro instanceof Stripe.errors.StripeCardError) {
    throw new ProviderInvalidRequestError(motivo(erro, contexto));
  }

  // NAO e erro da Stripe: TypeError nosso, bug de codigo. Sobe CRU de
  // proposito. Traduzir para ProviderUnavailableError faria o job do 6b
  // retentar um bug para sempre; falha visivel e melhor que retry infinito.
  throw erro;
}
