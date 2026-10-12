import { randomUUID } from 'node:crypto';

import { ProviderInvalidRequestError, type CreateChargeInput } from '../../../src/providers/payment-provider.port';
import { StripeProvider } from '../../../src/providers/stripe/stripe.provider';

/**
 * O que estes testes provam e o FORMATO DA REQUISICAO, nao o mapeamento da
 * resposta — esse ja esta provado em stripe.mapeamento.test.ts, por tabela.
 *
 * O `fetch` e dublado via Stripe.createFetchHttpClient, entao nada toca a rede
 * e nada depende de credencial real.
 */

interface Chamada {
  url: string;
  metodo: string;
  cabecalhos: Record<string, string>;
  corpo: URLSearchParams;
}

function fetchDublado(resposta: unknown, status = 200) {
  const chamadas: Chamada[] = [];
  const fn = (async (entrada: unknown, init?: RequestInit) => {
    const cabecalhos: Record<string, string> = {};
    new Headers(init?.headers).forEach((valor, nome) => {
      // Cabecalho HTTP e case-insensitive; Headers normaliza para minusculo.
      cabecalhos[nome] = valor;
    });
    chamadas.push({
      url: String(entrada),
      metodo: init?.method ?? 'GET',
      cabecalhos,
      corpo: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    });
    return new Response(JSON.stringify(resposta), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, chamadas };
}

function entrada(overrides: Partial<CreateChargeInput> = {}): CreateChargeInput {
  return {
    amountCents: 12990,
    currency: 'BRL',
    paymentMethodToken: 'pm_card_visa',
    idempotencyKey: 'pay_123:1',
    reference: { paymentId: 'pay_123', orderId: 'ord_456', attemptCount: 1 },
    ...overrides,
  };
}

const INTENT_OK = {
  id: 'pi_1',
  object: 'payment_intent',
  status: 'succeeded',
  amount: 12990,
  amount_received: 12990,
};

describe('StripeProvider — createCharge, formato da requisicao', () => {
  it('A1: declara ausenciaEDefinitiva FALSE — a consulta da Stripe nao prova ausencia', () => {
    const { fn } = fetchDublado(INTENT_OK);
    const provider = new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', fetchFn: fn });
    expect(provider.ausenciaEDefinitiva).toBe(false);
    expect(provider.name).toBe('stripe');
  });

  it('A2: POST em /v1/payment_intents com a NOSSA chave no header Idempotency-Key', async () => {
    const { fn, chamadas } = fetchDublado(INTENT_OK);
    const provider = new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', fetchFn: fn });

    await provider.createCharge(entrada({ idempotencyKey: 'pay_abc:3' }));

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(chamadas[0].metodo).toBe('POST');
    expect(chamadas[0].cabecalhos['idempotency-key']).toBe('pay_abc:3');
  });

  it('A3: o corpo leva a correlacao em metadata e NADA alem do necessario', async () => {
    const { fn, chamadas } = fetchDublado(INTENT_OK);
    const provider = new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', fetchFn: fn });

    await provider.createCharge(entrada());

    const corpo = chamadas[0].corpo;
    expect(corpo.get('amount')).toBe('12990');
    // Minusculas: a Stripe exige ISO lowercase.
    expect(corpo.get('currency')).toBe('brl');
    expect(corpo.get('payment_method')).toBe('pm_card_visa');
    expect(corpo.get('confirm')).toBe('true');
    expect(corpo.get('automatic_payment_methods[allow_redirects]')).toBe('never');
    expect(corpo.get('metadata[paymentId]')).toBe('pay_123');
    expect(corpo.get('metadata[orderId]')).toBe('ord_456');
    expect(corpo.get('metadata[attemptCount]')).toBe('1');

    // Conjunto FECHADO de parametros: campo novo no corpo derruba este caso.
    // Sem isto, alguem acrescentaria receipt_email ou customer sem revisao.
    expect([...corpo.keys()].sort()).toEqual([
      'amount',
      'automatic_payment_methods[allow_redirects]',
      'automatic_payment_methods[enabled]',
      'confirm',
      'currency',
      'metadata[attemptCount]',
      'metadata[orderId]',
      'metadata[paymentId]',
      'payment_method',
    ]);
  });

  it('A4: validacao local acontece ANTES da rede', async () => {
    const { fn, chamadas } = fetchDublado(INTENT_OK);
    const provider = new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', fetchFn: fn });

    await expect(provider.createCharge(entrada({ idempotencyKey: '   ' }))).rejects.toThrow(
      ProviderInvalidRequestError,
    );
    await expect(
      provider.createCharge(entrada({ currency: 'USD' as CreateChargeInput['currency'] })),
    ).rejects.toThrow(ProviderInvalidRequestError);

    expect(chamadas).toHaveLength(0);
  });

  it('A5: recusa do cartao volta como RESULTADO DECLINED, nao como excecao', async () => {
    // card_error da Stripe: 402 com o payment_intent no corpo do erro.
    const { fn } = fetchDublado(
      {
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card has insufficient funds.',
          payment_intent: {
            id: 'pi_recusado',
            object: 'payment_intent',
            status: 'requires_payment_method',
            amount: 12990,
            amount_received: 0,
          },
        },
      },
      402,
    );
    const provider = new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', fetchFn: fn });

    const resultado = await provider.createCharge(entrada({ idempotencyKey: randomUUID() }));

    expect(resultado).toMatchObject({
      providerRef: 'pi_recusado',
      state: 'DECLINED',
      capturedAmountCents: 0,
      declineCode: 'insufficient_funds',
    });
  });
});
