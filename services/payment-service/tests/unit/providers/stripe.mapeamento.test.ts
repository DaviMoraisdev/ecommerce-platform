import type Stripe from 'stripe';
import { ProviderInvalidRequestError } from '../../../src/providers/payment-provider.port';
import {
  EstadoInesperadoDoIntentError,
  EstadoInesperadoDoReembolsoError,
  ExpansaoAusenteError,
  REEMBOLSO_SEM_MOTIVO,
  resultadoDoReembolso,
  snapshotDaCobranca,
  eventoDoWebhook,
  type CobrancaLida,
  type EventoLido,
  type IntentComCobranca,
  type ReembolsoLido,
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

describe('stripe.mapeamento — snapshotDaCobranca', () => {
  // Teste de tipo: o Charge do SDK tem de servir ao que lemos, e o
  // PaymentIntent com expand tambem.
  const _cobrancaCompativel: CobrancaLida = {} as Stripe.Charge;
  void _cobrancaCompativel;

  function comCobranca(parcial: Partial<IntentComCobranca>): IntentComCobranca {
    return {
      id: 'pi_9',
      status: 'succeeded',
      amount: 12990,
      amount_received: 12990,
      latest_charge: { amount_captured: 12990, amount_refunded: 0 },
      ...parcial,
    };
  }

  it('S1: succeeded com reembolso parcial traz os tres valores', () => {
    expect(
      snapshotDaCobranca(
        comCobranca({ latest_charge: { amount_captured: 12990, amount_refunded: 3000 } }),
      ),
    ).toEqual({
      providerRef: 'pi_9',
      state: 'SUCCEEDED',
      amountCents: 12990,
      capturedAmountCents: 12990,
      refundedAmountCents: 3000,
    });
  });

  it('S2: latest_charge NAO expandido lanca em vez de ler zero reembolsado', () => {
    expect(() => snapshotDaCobranca(comCobranca({ latest_charge: 'ch_123' }))).toThrow(ExpansaoAusenteError);
  });

  it('S3: sem cobranca ainda, reembolsado e zero', () => {
    expect(
      snapshotDaCobranca(
        comCobranca({ status: 'processing', amount_received: 0, latest_charge: null }),
      ),
    ).toEqual({
      providerRef: 'pi_9',
      state: 'PROCESSING',
      amountCents: 12990,
      capturedAmountCents: 0,
      refundedAmountCents: 0,
    });
  });

  it('S4: canceled vira CANCELED, e nao DECLINED como na criacao', () => {
    expect(snapshotDaCobranca(comCobranca({ status: 'canceled', amount_received: 0 })).state).toBe('CANCELED');
  });

  it('S5: requires_payment_method com erro vira DECLINED com codigo', () => {
    const s = snapshotDaCobranca(
      comCobranca({
        status: 'requires_payment_method',
        amount_received: 0,
        last_payment_error: { decline_code: 'do_not_honor' },
      }),
    );
    expect(s.state).toBe('DECLINED');
    expect(s.declineCode).toBe('do_not_honor');
  });

  it('S6: status desconhecido vira PROCESSING — a varredura mantem a tentativa presa e visivel', () => {
    expect(snapshotDaCobranca(comCobranca({ status: 'estado_novo_da_stripe' })).state).toBe('PROCESSING');
  });
});

describe('stripe.mapeamento — resultadoDoReembolso', () => {
  const _reembolsoCompativel: ReembolsoLido = {} as Stripe.Refund;
  void _reembolsoCompativel;

  function reembolso(parcial: Partial<ReembolsoLido>): ReembolsoLido {
    return { id: 're_1', status: 'succeeded', amount: 3000, ...parcial };
  }

  it('R1: succeeded', () => {
    expect(resultadoDoReembolso(reembolso({}))).toEqual({
      providerRefundRef: 're_1',
      state: 'SUCCEEDED',
      amountCents: 3000,
    });
  });

  it.each(['pending', 'requires_action'])('R2: %s vira PROCESSING, nao falha', (status) => {
    expect(resultadoDoReembolso(reembolso({ status })).state).toBe('PROCESSING');
  });

  it.each(['failed', 'canceled'])('R3: %s vira DECLINED com failure_reason', (status) => {
    expect(resultadoDoReembolso(reembolso({ status, failure_reason: 'lost_or_stolen_card' }))).toEqual({
      providerRefundRef: 're_1',
      state: 'DECLINED',
      amountCents: 3000,
      declineCode: 'lost_or_stolen_card',
    });
  });

  it('R4: failed sem motivo usa o codigo de ausencia', () => {
    const r = resultadoDoReembolso(reembolso({ status: 'failed' }));
    expect(r.state === 'DECLINED' && r.declineCode).toBe(REEMBOLSO_SEM_MOTIVO);
  });

  it('R5: status desconhecido ou ausente LANCA — dinheiro saindo nao admite palpite', () => {
    expect(() => resultadoDoReembolso(reembolso({ status: 'estado_novo' }))).toThrow(
      EstadoInesperadoDoReembolsoError,
    );
    expect(() => resultadoDoReembolso(reembolso({ status: null }))).toThrow(EstadoInesperadoDoReembolsoError);
  });
});

describe('stripe.mapeamento — eventoDoWebhook', () => {
  const _eventoCompativel: EventoLido = {} as Stripe.Event;
  void _eventoCompativel;

  function ev(type: string, object: unknown, parcial: Partial<EventoLido> = {}): EventoLido {
    return { id: 'evt_1', type, created: 1_700_000_000, data: { object }, ...parcial };
  }

  it('W1: payment_intent.succeeded -> payment.succeeded, com created em segundos', () => {
    const r = eventoDoWebhook(ev('payment_intent.succeeded', { id: 'pi_1', amount_received: 12990 }));
    expect(r).toMatchObject({
      eventType: 'payment.succeeded',
      providerEventId: 'evt_1',
      providerEventTypeBruto: 'payment_intent.succeeded',
      providerRef: 'pi_1',
      state: 'SUCCEEDED',
      capturedAmountCents: 12990,
      refundedAmountCents: 0,
    });
    expect(r.providerCreatedAt).toEqual(new Date(1_700_000_000_000));
  });

  it('W2: payment_intent.payment_failed usa decline_code do emissor', () => {
    const r = eventoDoWebhook(
      ev('payment_intent.payment_failed', {
        id: 'pi_2',
        last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
      }),
    );
    expect(r).toMatchObject({ eventType: 'payment.failed', state: 'DECLINED', declineCode: 'insufficient_funds' });
  });

  it('W3: payment_failed SEM erro omite declineCode — ele e opcional na porta', () => {
    const r = eventoDoWebhook(ev('payment_intent.payment_failed', { id: 'pi_3' }));
    expect(r.eventType).toBe('payment.failed');
    expect(r).not.toHaveProperty('declineCode');
  });

  it('W4: payment_intent.canceled -> payment.canceled', () => {
    expect(eventoDoWebhook(ev('payment_intent.canceled', { id: 'pi_4' }))).toMatchObject({
      eventType: 'payment.canceled',
      state: 'CANCELED',
      providerRef: 'pi_4',
    });
  });

  it('W5: charge.refunded traz TOTAIS da cobranca e o ref do reembolso mais recente', () => {
    const r = eventoDoWebhook(
      ev('charge.refunded', {
        id: 'ch_1',
        payment_intent: 'pi_5',
        amount_captured: 12990,
        amount_refunded: 5000,
        refunds: { data: [{ id: 're_novo' }, { id: 're_antigo' }] },
      }),
    );
    expect(r).toMatchObject({
      eventType: 'refund.succeeded',
      providerRef: 'pi_5',
      providerRefundRef: 're_novo',
      state: 'SUCCEEDED',
      capturedAmountCents: 12990,
      refundedAmountCents: 5000,
    });
  });

  it('W6: charge.refunded sem payment_intent e conteudo INVALIDO, nao unsupported', () => {
    expect(() =>
      eventoDoWebhook(
        ev('charge.refunded', {
          id: 'ch_2',
          amount_captured: 1,
          amount_refunded: 1,
          refunds: { data: [{ id: 're_1' }] },
        }),
      ),
    ).toThrow(ProviderInvalidRequestError);
  });

  it('W7: charge.refunded com refunds vazio lanca — nao da para nomear o reembolso', () => {
    expect(() =>
      eventoDoWebhook(
        ev('charge.refunded', {
          id: 'ch_3',
          payment_intent: 'pi_7',
          amount_captured: 1,
          amount_refunded: 1,
          refunds: { data: [] },
        }),
      ),
    ).toThrow(ProviderInvalidRequestError);
  });

  it('W8: tipo que nao tratamos vira unsupported, SEM providerRef nem valores', () => {
    const r = eventoDoWebhook(ev('charge.dispute.created', { id: 'dp_1' }));
    expect(r.eventType).toBe('unsupported');
    expect(r).not.toHaveProperty('providerRef');
    expect(r.providerEventTypeBruto).toBe('charge.dispute.created');
  });

  it('W9: created invalido LANCA em vez de virar null — null travaria dinheiro', () => {
    expect(() =>
      eventoDoWebhook(ev('payment_intent.succeeded', { id: 'pi_9', amount_received: 1 }, { created: Number.NaN })),
    ).toThrow(ProviderInvalidRequestError);
  });

  it('W10: valor nao inteiro no evento e conteudo invalido', () => {
    expect(() => eventoDoWebhook(ev('payment_intent.succeeded', { id: 'pi_10', amount_received: 12.5 }))).toThrow(
      ProviderInvalidRequestError,
    );
  });
});
