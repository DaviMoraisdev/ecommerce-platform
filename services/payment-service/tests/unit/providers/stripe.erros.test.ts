import Stripe from 'stripe';

import {
  ChargeNotCancelableError,
  ChargeNotFoundError,
  ProviderAuthenticationError,
  ProviderInvalidRequestError,
  ProviderUnavailableError,
  RefundExceedsAvailableError,
  WebhookSignatureError,
} from '../../../src/providers/payment-provider.port';
import {
  CODIGO_ESTADO_INESPERADO,
  CODIGO_JA_REEMBOLSADO,
  CODIGO_RECURSO_AUSENTE,
  lancarTraduzido,
} from '../../../src/providers/stripe/stripe.erros';

/**
 * Fabrica o erro pelo caminho do SDK: a partir do objeto BRUTO da API.
 *
 * O `generate` do stripe-node decide a subclasse pelo STATUS HTTP, e nao pelo
 * `type` (so o idempotency_error e distinguido por type, dentro de 400/404).
 * A primeira versao deste helper nao mandava statusCode, e TODO erro virava
 * StripeAPIError — o que fez o caso de rate limit passar por coincidencia, ja
 * que api_error e rate_limit caem no mesmo ramo da nossa taxonomia.
 */
function bruto(
  tipo: string,
  statusCode: number,
  extras: Record<string, unknown> = {},
): Stripe.errors.StripeError {
  return Stripe.errors.StripeError.generate({
    type: tipo,
    statusCode,
    message: 'texto do provedor que NAO deve vazar',
    ...extras,
  } as never);
}

function capturar(erro: unknown, contexto: Parameters<typeof lancarTraduzido>[1]): unknown {
  try {
    lancarTraduzido(erro, contexto);
  } catch (lancado) {
    return lancado;
  }
  throw new Error('lancarTraduzido nao lancou — o retorno never foi violado');
}

describe('stripe.erros — taxonomia', () => {
  it('E1: api_error e transiente, e e o UNICO ramo retryable', () => {
    const traduzido = capturar(bruto('api_error', 500), 'criar');
    expect(traduzido).toBeInstanceOf(ProviderUnavailableError);
    expect((traduzido as ProviderUnavailableError).retryable).toBe(true);
  });

  it('E2: rate_limit (429) tambem e transiente — retentar com backoff e o certo', () => {
    // 429 e o que produz StripeRateLimitError. Sem o status, o SDK devolvia
    // StripeAPIError e este caso passava por coincidencia.
    const erro = bruto('rate_limit_error', 429);
    expect(erro).toBeInstanceOf(Stripe.errors.StripeRateLimitError);
    expect(capturar(erro, 'criar')).toBeInstanceOf(ProviderUnavailableError);
  });

  it('E3: authentication (401) e permission (403) sao configuracao, nao transiente', () => {
    const auth = capturar(bruto('authentication_error', 401), 'consultar');
    expect(auth).toBeInstanceOf(ProviderAuthenticationError);
    expect((auth as ProviderAuthenticationError).retryable).toBe(false);

    const permissao = capturar(bruto('invalid_request_error', 403), 'consultar');
    expect(permissao).toBeInstanceOf(ProviderAuthenticationError);
  });

  it('E4: idempotency_error e bug do chamador, nao retentavel', () => {
    const erro = bruto('idempotency_error', 400);
    expect(erro).toBeInstanceOf(Stripe.errors.StripeIdempotencyError);
    expect(capturar(erro, 'criar')).toBeInstanceOf(ProviderInvalidRequestError);
  });

  it('E5: resource_missing vira ChargeNotFound nos contextos de cobranca EXISTENTE', () => {
    for (const contexto of ['consultar', 'cancelar', 'reembolsar'] as const) {
      const traduzido = capturar(
        bruto('invalid_request_error', 404, { code: 'resource_missing' }),
        contexto,
      );
      expect(traduzido).toBeInstanceOf(ChargeNotFoundError);
    }
  });

  it('E5b: resource_missing na CRIACAO nao e cobranca ausente — e requisicao invalida', () => {
    // Em criar, o unico id que NOS enviamos e o do metodo de pagamento: a
    // cobranca ainda nao existe. Nomear "cobranca inexistente" aqui entrega aos
    // jobs de reconciliacao um FATO que nao e verdade.
    const traduzido = capturar(
      bruto('invalid_request_error', 404, { code: 'resource_missing', param: 'payment_method' }),
      'criar',
    );

    expect(traduzido).toBeInstanceOf(ProviderInvalidRequestError);
    expect(traduzido).not.toBeInstanceOf(ChargeNotFoundError);
  });

  it('E6: estado inesperado vira ChargeNotCancelable SO no contexto de cancelar', () => {
    const aoCancelar = capturar(
      bruto('invalid_request_error', 400, { code: CODIGO_ESTADO_INESPERADO }),
      'cancelar',
    );
    expect(aoCancelar).toBeInstanceOf(ChargeNotCancelableError);

    // O MESMO codigo em outro contexto NAO pode virar "nao cancelavel": o job
    // do 6e le essa classe como "ja capturou".
    const aoCriar = capturar(
      bruto('invalid_request_error', 400, { code: CODIGO_ESTADO_INESPERADO }),
      'criar',
    );
    expect(aoCriar).toBeInstanceOf(ProviderInvalidRequestError);
    expect(aoCriar).not.toBeInstanceOf(ChargeNotCancelableError);
  });

  it('E7: ja reembolsado vira RefundExceedsAvailable SO no contexto de reembolsar', () => {
    expect(
      capturar(bruto('invalid_request_error', 400, { code: CODIGO_JA_REEMBOLSADO }), 'reembolsar'),
    ).toBeInstanceOf(RefundExceedsAvailableError);
    expect(
      capturar(bruto('invalid_request_error', 400, { code: CODIGO_JA_REEMBOLSADO }), 'consultar'),
    ).toBeInstanceOf(ProviderInvalidRequestError);
  });

  it('E8: invalid_request SEM codigo conhecido NAO vira RefundExceedsAvailable', () => {
    // A porta proibe decidir por MENSAGEM em ramo de dinheiro. Codigo
    // desconhecido no reembolso fica em requisicao invalida; verificacao do
    // codigo real fica para o 9c.
    const traduzido = capturar(
      bruto('invalid_request_error', 400, { code: 'algum_codigo_novo' }),
      'reembolsar',
    );
    expect(traduzido).toBeInstanceOf(ProviderInvalidRequestError);
    expect(traduzido).not.toBeInstanceOf(RefundExceedsAvailableError);
  });

  it('E9: falha de assinatura vira WebhookSignatureError', () => {
    const erro = new Stripe.errors.StripeSignatureVerificationError('t=1,v1=x', '{}');
    expect(capturar(erro, 'webhook')).toBeInstanceOf(WebhookSignatureError);
  });

  it('E10: erro JA nosso passa reto, sem retraducao', () => {
    const nosso = new ChargeNotFoundError('ja era nosso');
    expect(capturar(nosso, 'consultar')).toBe(nosso);
  });

  it('E11: erro que NAO e da Stripe sobe CRU — bug nao pode virar retentavel', () => {
    const bug = new TypeError('undefined nao e funcao');
    expect(capturar(bug, 'criar')).toBe(bug);
  });

  it('E13: card_error (402) FORA da criacao e requisicao invalida', () => {
    // Na criacao, recusa e RESULTADO e nem chega aqui. Em consultar, cancelar
    // ou reembolsar, um card_error nao tem significado de negocio para nos.
    const erro = bruto('card_error', 402, { code: 'card_declined' });
    expect(erro).toBeInstanceOf(Stripe.errors.StripeCardError);
    expect(capturar(erro, 'reembolsar')).toBeInstanceOf(ProviderInvalidRequestError);
  });

  it('E12: a mensagem traduzida NAO carrega o texto do provedor', () => {
    const traduzido = capturar(bruto('api_error', 500, { code: 'algo' }), 'criar') as Error;
    expect(traduzido.message).not.toContain('texto do provedor');
    expect(traduzido.message).toContain('tipo');
    expect(traduzido.message).toContain('codigo algo');
  });
});
