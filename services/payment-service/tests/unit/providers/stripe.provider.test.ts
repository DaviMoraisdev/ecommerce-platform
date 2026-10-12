import Stripe from 'stripe';

import { randomUUID } from 'node:crypto';

import {
  ChargeNotCancelableError,
  ChargeNotFoundError,
  ProviderInvalidRequestError,
  ProviderUnavailableError,
  WebhookSignatureError,
  type CreateChargeInput,
} from '../../../src/providers/payment-provider.port';
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

/**
 * Dublê com FILA de respostas: o caminho de erro do cancelamento faz duas
 * chamadas (cancel e depois retrieve), e um dublê de resposta unica nao
 * conseguiria representar isso.
 */
function fetchEmFila(respostas: Array<{ corpo: unknown; status?: number }>) {
  const chamadas: Chamada[] = [];
  const fn = (async (entradaUrl: unknown, init?: RequestInit) => {
    const cabecalhos: Record<string, string> = {};
    new Headers(init?.headers).forEach((valor, nome) => {
      cabecalhos[nome] = valor;
    });
    chamadas.push({
      url: String(entradaUrl),
      metodo: init?.method ?? 'GET',
      cabecalhos,
      corpo: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    });
    const proxima = respostas[chamadas.length - 1];
    if (proxima === undefined) throw new Error('dublê sem resposta para a chamada ' + chamadas.length);
    return new Response(JSON.stringify(proxima.corpo), {
      status: proxima.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, chamadas };
}

function provedor(fn: typeof fetch): StripeProvider {
  return new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', fetchFn: fn });
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


describe('StripeProvider — getCharge, cancelCharge e refund', () => {
  const INTENT_CAPTURADO = {
    id: 'pi_1',
    object: 'payment_intent',
    status: 'succeeded',
    amount: 12990,
    amount_received: 12990,
    latest_charge: { id: 'ch_1', object: 'charge', amount_captured: 12990, amount_refunded: 3000 },
  };

  const INTENT_CANCELADO = {
    id: 'pi_1',
    object: 'payment_intent',
    status: 'canceled',
    amount: 12990,
    amount_received: 0,
    latest_charge: null,
  };

  const ESTADO_INESPERADO = {
    error: {
      type: 'invalid_request_error',
      code: 'payment_intent_unexpected_state',
      message: 'cannot be canceled',
    },
  };

  it('B1: getCharge pede expand[latest_charge] — sem ele o reembolsado seria lido como zero', async () => {
    const { fn, chamadas } = fetchEmFila([{ corpo: INTENT_CAPTURADO }]);

    const snapshot = await provedor(fn).getCharge('pi_1');

    expect(chamadas[0].metodo).toBe('GET');
    expect(decodeURIComponent(chamadas[0].url)).toBe(
      'https://api.stripe.com/v1/payment_intents/pi_1?expand[0]=latest_charge',
    );
    expect(snapshot).toEqual({
      providerRef: 'pi_1',
      state: 'SUCCEEDED',
      amountCents: 12990,
      capturedAmountCents: 12990,
      refundedAmountCents: 3000,
    });
  });

  it('B2: referencia inexistente vira ChargeNotFoundError pela taxonomia', async () => {
    const { fn } = fetchEmFila([
      { corpo: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'no such pi' } }, status: 404 },
    ]);

    await expect(provedor(fn).getCharge('pi_nao_existe')).rejects.toBeInstanceOf(ChargeNotFoundError);
  });

  it('B3: cancelCharge faz POST em /cancel com a NOSSA chave e com expand', async () => {
    const { fn, chamadas } = fetchEmFila([{ corpo: INTENT_CANCELADO }]);

    const snapshot = await provedor(fn).cancelCharge({ providerRef: 'pi_1', idempotencyKey: 'cancel:pi_1' });

    expect(chamadas[0].metodo).toBe('POST');
    expect(chamadas[0].url).toBe('https://api.stripe.com/v1/payment_intents/pi_1/cancel');
    expect(chamadas[0].cabecalhos['idempotency-key']).toBe('cancel:pi_1');
    expect(chamadas[0].corpo.get('expand[0]')).toBe('latest_charge');
    expect(snapshot.state).toBe('CANCELED');
  });

  it('B4: cancelar o que JA esta cancelado e no-op, mesmo com chave nova', async () => {
    // Estado inesperado, e a leitura seguinte mostra canceled: no-op.
    const { fn, chamadas } = fetchEmFila([
      { corpo: ESTADO_INESPERADO, status: 400 },
      { corpo: INTENT_CANCELADO },
    ]);

    const snapshot = await provedor(fn).cancelCharge({ providerRef: 'pi_1', idempotencyKey: 'chave-nova' });

    expect(snapshot.state).toBe('CANCELED');
    // Duas chamadas: o cancel que falhou e a leitura que desambiguou.
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1].metodo).toBe('GET');
  });

  it('B5: cancelar o que JA foi capturado vira ChargeNotCancelableError', async () => {
    // MESMO codigo de erro do B4; so o estado distingue.
    const { fn, chamadas } = fetchEmFila([
      { corpo: ESTADO_INESPERADO, status: 400 },
      { corpo: INTENT_CAPTURADO },
    ]);

    await expect(
      provedor(fn).cancelCharge({ providerRef: 'pi_1', idempotencyKey: 'chave-nova' }),
    ).rejects.toBeInstanceOf(ChargeNotCancelableError);
    expect(chamadas).toHaveLength(2);
  });

  it('B6: refund usa payment_intent, com corpo FECHADO e a nossa chave', async () => {
    const { fn, chamadas } = fetchEmFila([
      { corpo: { id: 're_1', object: 'refund', status: 'succeeded', amount: 3000 } },
    ]);

    const resultado = await provedor(fn).refund({
      providerRef: 'pi_1',
      amountCents: 3000,
      idempotencyKey: 'refund:pi_1:1',
    });

    expect(chamadas[0].url).toBe('https://api.stripe.com/v1/refunds');
    expect(chamadas[0].cabecalhos['idempotency-key']).toBe('refund:pi_1:1');
    expect([...chamadas[0].corpo.keys()].sort()).toEqual(['amount', 'payment_intent']);
    expect(chamadas[0].corpo.get('payment_intent')).toBe('pi_1');
    expect(resultado).toEqual({ providerRefundRef: 're_1', state: 'SUCCEEDED', amountCents: 3000 });
  });

  it('B7: reembolso pendente vira PROCESSING, nao falha', async () => {
    const { fn } = fetchEmFila([
      { corpo: { id: 're_2', object: 'refund', status: 'pending', amount: 3000 } },
    ]);

    const resultado = await provedor(fn).refund({
      providerRef: 'pi_1',
      amountCents: 3000,
      idempotencyKey: 'refund:pi_1:2',
    });

    expect(resultado.state).toBe('PROCESSING');
  });
});

describe('StripeProvider — buscarCobrancaPorTentativa', () => {
  function intentCom(metadata: Record<string, string>, id = 'pi_achado'): unknown {
    return {
      id,
      object: 'payment_intent',
      status: 'succeeded',
      amount: 12990,
      amount_received: 12990,
      latest_charge: { id: 'ch_1', object: 'charge', amount_captured: 12990, amount_refunded: 0 },
      metadata,
    };
  }

  const CORRELACAO = { paymentId: 'pay_123', orderId: 'ord_456', attemptCount: '2' };

  it('C1: lista por janela de created com expand de data.latest_charge', async () => {
    const { fn, chamadas } = fetchEmFila([
      { corpo: { object: 'list', has_more: false, data: [intentCom(CORRELACAO)] } },
    ]);

    const snapshot = await provedor(fn).buscarCobrancaPorTentativa('pay_123', 2);

    const url = decodeURIComponent(chamadas[0].url);
    expect(chamadas[0].metodo).toBe('GET');
    expect(url).toContain('https://api.stripe.com/v1/payment_intents?');
    expect(url).toContain('created[gte]=');
    expect(url).toContain('limit=100');
    expect(url).toContain('expand[0]=data.latest_charge');
    expect(snapshot?.providerRef).toBe('pi_achado');
    expect(snapshot?.refundedAmountCents).toBe(0);
  });

  it('C2: nao achou e nao ha mais paginas devolve null, com UMA chamada', async () => {
    const { fn, chamadas } = fetchEmFila([{ corpo: { object: 'list', has_more: false, data: [] } }]);

    expect(await provedor(fn).buscarCobrancaPorTentativa('pay_123', 2)).toBeNull();
    expect(chamadas).toHaveLength(1);
  });

  it('C3: pagina com starting_after no ultimo id e acha na pagina seguinte', async () => {
    const { fn, chamadas } = fetchEmFila([
      { corpo: { object: 'list', has_more: true, data: [intentCom({ paymentId: 'outro', attemptCount: '1' }, 'pi_outro')] } },
      { corpo: { object: 'list', has_more: false, data: [intentCom(CORRELACAO)] } },
    ]);

    const snapshot = await provedor(fn).buscarCobrancaPorTentativa('pay_123', 2);

    expect(snapshot?.providerRef).toBe('pi_achado');
    expect(chamadas).toHaveLength(2);
    expect(decodeURIComponent(chamadas[1].url)).toContain('starting_after=pi_outro');
  });

  it('C4: distingue TENTATIVAS do mesmo pagamento', async () => {
    // Mesmo paymentId, attemptCount diferente: nao e a cobranca procurada.
    const { fn } = fetchEmFila([
      {
        corpo: {
          object: 'list',
          has_more: false,
          data: [intentCom({ paymentId: 'pay_123', orderId: 'ord_456', attemptCount: '1' })],
        },
      },
    ]);

    expect(await provedor(fn).buscarCobrancaPorTentativa('pay_123', 2)).toBeNull();
  });

  it('C5: teto de paginas LANCA em vez de afirmar ausencia', async () => {
    // "Nao terminei de olhar" nao e "nao existe". Devolver null aqui diria ao
    // job do 6b que a cobranca nunca chegou ao provedor — e ele poderia
    // liberar a tentativa se a flag permitisse.
    const pagina = {
      corpo: {
        object: 'list',
        has_more: true,
        data: [intentCom({ paymentId: 'outro', attemptCount: '9' }, 'pi_x')],
      },
    };
    const { fn, chamadas } = fetchEmFila([pagina, pagina]);
    const provider = new StripeProvider({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_x',
      fetchFn: fn,
      tetoDePaginas: 2,
    });

    await expect(provider.buscarCobrancaPorTentativa('pay_123', 2)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(chamadas).toHaveLength(2);
  });
});

describe('StripeProvider — verifyWebhook', () => {
  const SEGREDO = 'whsec_teste_0000111122223333';

  function corpoAssinado(
    evento: unknown,
    opcoes: { segredo?: string; timestamp?: number } = {},
  ): { rawBody: Buffer; headers: Record<string, string> } {
    const payload = JSON.stringify(evento);
    const assinatura = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: opcoes.segredo ?? SEGREDO,
      ...(opcoes.timestamp === undefined ? {} : { timestamp: opcoes.timestamp }),
    });
    return { rawBody: Buffer.from(payload, 'utf8'), headers: { 'stripe-signature': assinatura } };
  }

  function comWebhook(): StripeProvider {
    const { fn } = fetchEmFila([]);
    return new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: SEGREDO, fetchFn: fn });
  }

  const EVENTO_SUCESSO = {
    id: 'evt_1',
    object: 'event',
    type: 'payment_intent.succeeded',
    created: 1_700_000_000,
    data: { object: { id: 'pi_1', object: 'payment_intent', amount_received: 12990 } },
  };

  it('D1: assinatura valida devolve o evento JA no nosso vocabulario', () => {
    const { rawBody, headers } = corpoAssinado(EVENTO_SUCESSO);

    const evento = comWebhook().verifyWebhook({ rawBody, headers });

    expect(evento).toMatchObject({
      eventType: 'payment.succeeded',
      providerEventId: 'evt_1',
      providerRef: 'pi_1',
      capturedAmountCents: 12990,
    });
  });

  it('D2: assinado com OUTRO segredo vira WebhookSignatureError', () => {
    const { rawBody, headers } = corpoAssinado(EVENTO_SUCESSO, { segredo: 'whsec_outro_000' });

    expect(() => comWebhook().verifyWebhook({ rawBody, headers })).toThrow(WebhookSignatureError);
  });

  it('D3: cabecalho ausente vira WebhookSignatureError, nao TypeError', () => {
    const payload = Buffer.from(JSON.stringify(EVENTO_SUCESSO), 'utf8');

    expect(() => comWebhook().verifyWebhook({ rawBody: payload, headers: {} })).toThrow(
      WebhookSignatureError,
    );
    expect(() =>
      comWebhook().verifyWebhook({ rawBody: payload, headers: { 'stripe-signature': '   ' } }),
    ).toThrow(WebhookSignatureError);
  });

  it('D4: timestamp fora da janela antirreplay vira WebhookSignatureError', () => {
    // Uma hora atras, contra a tolerancia default de 300s do SDK.
    const umaHoraAtras = Math.floor(Date.now() / 1000) - 3600;
    const { rawBody, headers } = corpoAssinado(EVENTO_SUCESSO, { timestamp: umaHoraAtras });

    expect(() => comWebhook().verifyWebhook({ rawBody, headers })).toThrow(WebhookSignatureError);
  });

  it('D5: evento autentico de tipo que nao tratamos vira unsupported', () => {
    // Prova que o payload passa pelo nosso mapeamento, e nao direto do SDK.
    const { rawBody, headers } = corpoAssinado({
      ...EVENTO_SUCESSO,
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1' } },
    });

    const evento = comWebhook().verifyWebhook({ rawBody, headers });

    expect(evento.eventType).toBe('unsupported');
    expect(evento.providerEventTypeBruto).toBe('charge.dispute.created');
  });

  it('D6: retentativa de rede e DECLARADA — 1 retentativa produz 2 chamadas', async () => {
    const erro500 = { corpo: { error: { type: 'api_error', message: 'oops' } }, status: 500 };
    const { fn, chamadas } = fetchEmFila([erro500, erro500]);
    const provider = new StripeProvider({
      secretKey: 'sk_test_x',
      webhookSecret: SEGREDO,
      fetchFn: fn,
      maxRetentativasDeRede: 1,
    });

    await expect(provider.getCharge('pi_1')).rejects.toBeInstanceOf(ProviderUnavailableError);
    // Retentar e seguro porque o SDK reusa a nossa chave de idempotencia.
    expect(chamadas).toHaveLength(2);
  }, 15_000);
});
