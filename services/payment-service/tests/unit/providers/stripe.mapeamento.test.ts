import type Stripe from 'stripe';
import {
  EstadoInesperadoDoIntentError,
  RECUSA_POR_CANCELAMENTO,
  RECUSA_SEM_CODIGO,
  recusaDeCobranca,
  resultadoDaCriacao,
  type IntentLido,
} from '../../../src/providers/stripe/stripe.mapeamento';

/**
 * TESTE DE TIPO, nao de runtime: o objeto do SDK tem de ser atribuivel ao que
 * lemos. Se a Stripe renomear ou retipar um desses campos, o `tsc` do gate
 * quebra aqui — e nao em producao, na primeira cobranca.
 */
const _compativelComOSdk: IntentLido = {} as Stripe.PaymentIntent;
void _compativelComOSdk;

function intent(parcial: Partial<IntentLido>): IntentLido {
  return { id: 'pi_1', status: 'succeeded', amount: 12990, amount_received: 12990, ...parcial };
}

describe('stripe.mapeamento — resultadoDaCriacao', () => {
  it('M1: succeeded usa amount_received, e nao amount', () => {
    expect(resultadoDaCriacao(intent({ status: 'succeeded', amount: 12990, amount_received: 12990 }))).toEqual({
      providerRef: 'pi_1',
      state: 'SUCCEEDED',
      capturedAmountCents: 12990,
    });
  });

  it.each(['processing', 'requires_action', 'requires_capture'])(
    'M2: %s vira PROCESSING com zero capturado',
    (status) => {
      expect(resultadoDaCriacao(intent({ status, amount_received: 0 }))).toEqual({
        providerRef: 'pi_1',
        state: 'PROCESSING',
        capturedAmountCents: 0,
      });
    },
  );

  it('M3: canceled vira DECLINED com codigo proprio', () => {
    expect(resultadoDaCriacao(intent({ status: 'canceled', amount_received: 0 }))).toEqual({
      providerRef: 'pi_1',
      state: 'DECLINED',
      capturedAmountCents: 0,
      declineCode: RECUSA_POR_CANCELAMENTO,
    });
  });

  it('M4: requires_payment_method COM last_payment_error e recusa', () => {
    const r = resultadoDaCriacao(
      intent({
        status: 'requires_payment_method',
        amount_received: 0,
        last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Sem saldo.' },
      }),
    );
    expect(r).toEqual({
      providerRef: 'pi_1',
      state: 'DECLINED',
      capturedAmountCents: 0,
      declineCode: 'insufficient_funds',
      declineMessage: 'Sem saldo.',
    });
  });

  it('M5: requires_payment_method SEM last_payment_error lanca — status ambiguo', () => {
    expect(() => resultadoDaCriacao(intent({ status: 'requires_payment_method', amount_received: 0 }))).toThrow(
      EstadoInesperadoDoIntentError,
    );
    expect(() =>
      resultadoDaCriacao(intent({ status: 'requires_payment_method', amount_received: 0, last_payment_error: null })),
    ).toThrow(EstadoInesperadoDoIntentError);
  });

  it('M6: requires_confirmation lanca — confirmamos na propria criacao', () => {
    expect(() => resultadoDaCriacao(intent({ status: 'requires_confirmation' }))).toThrow(
      EstadoInesperadoDoIntentError,
    );
  });

  it('M7: status DESCONHECIDO lanca em vez de virar estado parecido', () => {
    expect(() => resultadoDaCriacao(intent({ status: 'estado_que_a_stripe_inventar' }))).toThrow(
      EstadoInesperadoDoIntentError,
    );
  });
});

describe('stripe.mapeamento — recusaDeCobranca', () => {
  it('M8: decline_code do EMISSOR tem precedencia sobre code da Stripe', () => {
    expect(recusaDeCobranca('pi_2', { code: 'card_declined', decline_code: 'lost_card' }).declineCode).toBe('lost_card');
  });

  it('M9: cai para code quando decline_code vem vazio ou so com espacos', () => {
    expect(recusaDeCobranca('pi_2', { code: 'card_declined', decline_code: '   ' }).declineCode).toBe('card_declined');
    expect(recusaDeCobranca('pi_2', { code: 'card_declined', decline_code: null }).declineCode).toBe('card_declined');
  });

  it('M10: sem nenhum dos dois, usa o codigo de ausencia — declineCode nunca falta', () => {
    expect(recusaDeCobranca('pi_2', {}).declineCode).toBe(RECUSA_SEM_CODIGO);
  });

  it('M11: declineMessage e OMITIDA quando vazia, em vez de virar string vazia', () => {
    expect(recusaDeCobranca('pi_2', { code: 'x', message: '  ' })).not.toHaveProperty('declineMessage');
  });
});
