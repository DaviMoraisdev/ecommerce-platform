/**
 * Tokens deterministicos do FakeProvider.
 *
 * Espelham os tokens de teste de provedores reais (a Stripe usa tok_visa,
 * tok_chargeDeclined etc.). Sao TOKENS, nao numeros de cartao: o servico nunca
 * ve PAN — ver a nota de PCI em CreateChargeInput.paymentMethodToken.
 */

export const FAKE_TOKENS = {
  /** Autoriza e captura na propria chamada. */
  SUCCESS: 'tok_fake_success',
  /** Aceito, mas a confirmacao vem SO por webhook — exercita o caminho assincrono. */
  PROCESSING: 'tok_fake_processing',

  DECLINED_INSUFFICIENT_FUNDS: 'tok_fake_declined_insufficient_funds',
  DECLINED_EXPIRED_CARD: 'tok_fake_declined_expired_card',
  DECLINED_FRAUD: 'tok_fake_declined_fraud',

  ERROR_UNAVAILABLE: 'tok_fake_error_unavailable',
  ERROR_INVALID: 'tok_fake_error_invalid',
  ERROR_AUTHENTICATION: 'tok_fake_error_authentication',
} as const;

export type FakeToken = (typeof FAKE_TOKENS)[keyof typeof FAKE_TOKENS];

/**
 * Recusa e comportamento de NEGOCIO (kind: 'decline') e volta como resultado.
 * Falha tecnica e 'error' e vira excecao. A separacao esta na porta.
 */
export type FakeBehavior =
  | { kind: 'succeed' }
  | { kind: 'processing' }
  | { kind: 'decline'; code: string; message: string }
  | { kind: 'error'; error: 'unavailable' | 'invalid' | 'authentication' };

const COMPORTAMENTOS: Record<FakeToken, FakeBehavior> = {
  [FAKE_TOKENS.SUCCESS]: { kind: 'succeed' },
  [FAKE_TOKENS.PROCESSING]: { kind: 'processing' },

  [FAKE_TOKENS.DECLINED_INSUFFICIENT_FUNDS]: {
    kind: 'decline',
    code: 'insufficient_funds',
    message: 'Saldo insuficiente',
  },
  [FAKE_TOKENS.DECLINED_EXPIRED_CARD]: {
    kind: 'decline',
    code: 'expired_card',
    message: 'Cartao expirado',
  },
  [FAKE_TOKENS.DECLINED_FRAUD]: {
    kind: 'decline',
    code: 'fraudulent',
    message: 'Transacao recusada pelo emissor',
  },

  [FAKE_TOKENS.ERROR_UNAVAILABLE]: { kind: 'error', error: 'unavailable' },
  [FAKE_TOKENS.ERROR_INVALID]: { kind: 'error', error: 'invalid' },
  [FAKE_TOKENS.ERROR_AUTHENTICATION]: { kind: 'error', error: 'authentication' },
};

/**
 * Devolve undefined para token desconhecido — e o chamador DEVE tratar como
 * erro. Token nao reconhecido nunca pode virar sucesso silencioso: seria o
 * Fake sendo mais permissivo que o provedor real, e a suite de contrato
 * passaria contra o Fake e falharia contra a Stripe.
 */
export function comportamentoDoToken(token: string): FakeBehavior | undefined {
  return (COMPORTAMENTOS as Record<string, FakeBehavior | undefined>)[token];
}
