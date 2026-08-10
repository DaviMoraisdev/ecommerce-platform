import { randomUUID } from 'node:crypto';

import {
  ProviderAuthenticationError,
  ProviderInvalidRequestError,
  ProviderUnavailableError,
  WebhookSignatureError,
  type CreateChargeInput,
  type PaymentProvider,
} from '../../../src/providers/payment-provider.port';
import { FakeProvider, FAKE_SIGNATURE_HEADER } from '../../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../../src/providers/fake/fake.tokens';
import { MAX_AMOUNT_CENTS } from '../../../src/domain/money';
import { rodarContratoDeProvedor } from './payment-provider.contract';

const SEGREDO = 'segredo-de-teste-do-fake';

function criarFake(
  overrides: Partial<{ now: () => Date; toleranciaSegundos: number }> = {},
): FakeProvider {
  return new FakeProvider({ webhookSecret: SEGREDO, ...overrides });
}

function entradaDeCobranca(overrides: Partial<CreateChargeInput> = {}): CreateChargeInput {
  return {
    amountCents: 1000,
    currency: 'BRL',
    paymentMethodToken: FAKE_TOKENS.SUCCESS,
    idempotencyKey: randomUUID(),
    reference: { paymentId: randomUUID(), orderId: randomUUID() },
    ...overrides,
  };
}

// A MESMA suite que vai rodar contra a Stripe no Bloco 9.
rodarContratoDeProvedor({
  nome: 'FakeProvider',
  criar: () => criarFake(),
  tokens: {
    sucesso: FAKE_TOKENS.SUCCESS,
    processando: FAKE_TOKENS.PROCESSING,
    recusado: FAKE_TOKENS.DECLINED_INSUFFICIENT_FUNDS,
    desconhecido: 'tok_que_nao_existe',
    erroTransiente: FAKE_TOKENS.ERROR_UNAVAILABLE,
  },
  capacidades: {
    falhaTransiente: true,
    transicaoAssincrona: true,
  },
  assinarWebhook: (provider: PaymentProvider, input) =>
    (provider as FakeProvider).construirWebhook({
      providerRef: input.providerRef,
      eventType: input.eventType,
    }),
  simularSucesso: (provider: PaymentProvider, providerRef: string) =>
    (provider as FakeProvider).simularTransicao({
      providerRef,
      eventType: 'payment.succeeded',
    }),
});

// ==========================================================
// Especificos do Fake — nao entram no contrato
// ==========================================================

describe('FakeProvider — construcao', () => {
  it.each(['', '   '])('exige webhookSecret nao vazio (%p)', (segredo) => {
    expect(() => new FakeProvider({ webhookSecret: segredo })).toThrow(
      ProviderInvalidRequestError,
    );
  });

  /**
   * O ponto destes casos: NaN e Infinity tornariam "idade > tolerancia" sempre
   * FALSO, e a protecao antirreplay deixaria de existir sem nenhum sinal.
   * Recusar na construcao e fail-closed.
   */
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negativo', -1],
    ['fracionario', 1.5],
    ['acima do maximo', 3601],
  ])('recusa toleranciaSegundos %s', (_rotulo, tolerancia) => {
    expect(() => new FakeProvider({ webhookSecret: SEGREDO, toleranciaSegundos: tolerancia })).toThrow(
      ProviderInvalidRequestError,
    );
  });

  it.each([0, 1, 300, 3600])('aceita toleranciaSegundos %i', (tolerancia) => {
    expect(
      () => new FakeProvider({ webhookSecret: SEGREDO, toleranciaSegundos: tolerancia }),
    ).not.toThrow();
  });
});

describe('FakeProvider — relogio invalido e fail-closed', () => {
  it('recusa o webhook quando o relogio nao produz tempo finito', async () => {
    // Assina com um provider de relogio VALIDO, para que a assinatura confira.
    const assinador = criarFake();
    const criada = await assinador.createCharge(
      entradaDeCobranca({ paymentMethodToken: FAKE_TOKENS.PROCESSING }),
    );
    const request = assinador.simularTransicao({
      providerRef: criada.providerRef,
      eventType: 'payment.succeeded',
    });

    // Verifica com um provider cujo relogio esta quebrado. Sem a validacao, a
    // idade seria NaN, "NaN > tolerancia" seria falso, e o evento passaria.
    const quebrado = criarFake({ now: () => new Date('data-invalida') });

    expect(() => quebrado.verifyWebhook(request)).toThrow(WebhookSignatureError);
    expect(() => quebrado.verifyWebhook(request)).toThrow(/relogio invalido/);
  });
});

describe('FakeProvider — mapeamento de erro tecnico', () => {
  it.each([
    [FAKE_TOKENS.ERROR_UNAVAILABLE, ProviderUnavailableError, true],
    [FAKE_TOKENS.ERROR_INVALID, ProviderInvalidRequestError, false],
    [FAKE_TOKENS.ERROR_AUTHENTICATION, ProviderAuthenticationError, false],
  ])('%s produz o erro esperado com retryable=%p', async (token, classe, retryable) => {
    const provider = criarFake();

    // Captura de uma UNICA chamada e asercoes fora do catch: se a chamada
    // resolver, capturado fica undefined e as duas asercoes falham. A versao
    // anterior fazia duas chamadas e podia ficar verde sem verificar retryable.
    let capturado: unknown;
    try {
      await provider.createCharge(entradaDeCobranca({ paymentMethodToken: token }));
    } catch (erro) {
      capturado = erro;
    }

    expect(capturado).toBeInstanceOf(classe);
    expect((capturado as { retryable: boolean }).retryable).toBe(retryable);
  });

  it('erro tecnico NAO consome a chave de idempotencia — retentar pode suceder', async () => {
    const provider = criarFake();
    const idempotencyKey = randomUUID();
    const reference = { paymentId: randomUUID(), orderId: randomUUID() };

    await expect(
      provider.createCharge(
        entradaDeCobranca({
          idempotencyKey,
          reference,
          paymentMethodToken: FAKE_TOKENS.ERROR_UNAVAILABLE,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    // Se a chave tivesse sido consumida, esta chamada devolveria uma cobranca
    // inexistente e o pagamento ficaria preso para sempre.
    const r = await provider.createCharge(
      entradaDeCobranca({ idempotencyKey, reference, paymentMethodToken: FAKE_TOKENS.SUCCESS }),
    );

    expect(r.state).toBe('SUCCEEDED');
  });

  it.each([
    [FAKE_TOKENS.DECLINED_INSUFFICIENT_FUNDS, 'insufficient_funds'],
    [FAKE_TOKENS.DECLINED_EXPIRED_CARD, 'expired_card'],
    [FAKE_TOKENS.DECLINED_FRAUD, 'fraudulent'],
  ])('%s recusa com declineCode %s', async (token, codigo) => {
    const provider = criarFake();
    const r = await provider.createCharge(entradaDeCobranca({ paymentMethodToken: token }));

    expect(r.state).toBe('DECLINED');
    if (r.state !== 'DECLINED') throw new Error('estado inesperado');

    expect(r.declineCode).toBe(codigo);
    expect(typeof r.declineMessage).toBe('string');
  });
});

describe('FakeProvider — verificacao de assinatura', () => {
  async function comCobrancaEmProcessamento() {
    const provider = criarFake();
    const criada = await provider.createCharge(
      entradaDeCobranca({ paymentMethodToken: FAKE_TOKENS.PROCESSING }),
    );
    return { provider, providerRef: criada.providerRef };
  }

  it('recusa assinatura feita com outro segredo', async () => {
    const { provider, providerRef } = await comCobrancaEmProcessamento();

    const request = provider.construirWebhook({
      providerRef,
      eventType: 'payment.succeeded',
      assinarCom: 'segredo-do-atacante',
    });

    expect(() => provider.verifyWebhook(request)).toThrow(WebhookSignatureError);
  });

  it.each([
    ['cabecalho vazio', ''],
    ['sem os campos t e v1', 'lixo'],
    ['so com t', 't=123'],
    ['so com v1', 'v1=abc'],
    ['timestamp nao numerico', 't=ontem,v1=abc'],
    ['timestamp zero', 't=0,v1=abc'],
    ['timestamp negativo', 't=-1,v1=abc'],
  ])('recusa cabecalho malformado: %s', async (_rotulo, valor) => {
    const { provider, providerRef } = await comCobrancaEmProcessamento();
    const request = provider.construirWebhook({ providerRef, eventType: 'payment.succeeded' });

    expect(() =>
      provider.verifyWebhook({ ...request, headers: { [FAKE_SIGNATURE_HEADER]: valor } }),
    ).toThrow(WebhookSignatureError);
  });

  it('aceita o cabecalho independente de caixa', async () => {
    const { provider, providerRef } = await comCobrancaEmProcessamento();
    const request = provider.construirWebhook({ providerRef, eventType: 'payment.succeeded' });
    const valor = request.headers[FAKE_SIGNATURE_HEADER] as string;

    expect(() =>
      provider.verifyWebhook({ ...request, headers: { 'X-Fake-Signature': valor } }),
    ).not.toThrow();
  });

  it('REPLAY: recusa evento fora da janela de tolerancia', async () => {
    const agora = new Date('2026-08-10T12:00:00.000Z');
    const provider = criarFake({ now: () => agora, toleranciaSegundos: 300 });
    const criada = await provider.createCharge(
      entradaDeCobranca({ paymentMethodToken: FAKE_TOKENS.PROCESSING }),
    );

    const request = provider.construirWebhook({
      providerRef: criada.providerRef,
      eventType: 'payment.succeeded',
      timestampSegundos: Math.floor(agora.getTime() / 1000) - 301,
    });

    expect(() => provider.verifyWebhook(request)).toThrow(/tolerancia/);
  });

  it('aceita evento no limite exato da tolerancia', async () => {
    const agora = new Date('2026-08-10T12:00:00.000Z');
    const provider = criarFake({ now: () => agora, toleranciaSegundos: 300 });
    const criada = await provider.createCharge(
      entradaDeCobranca({ paymentMethodToken: FAKE_TOKENS.PROCESSING }),
    );

    const request = provider.construirWebhook({
      providerRef: criada.providerRef,
      eventType: 'payment.succeeded',
      timestampSegundos: Math.floor(agora.getTime() / 1000) - 300,
    });

    expect(() => provider.verifyWebhook(request)).not.toThrow();
  });

  it('REPLAY: trocar o timestamp do cabecalho invalida a assinatura', async () => {
    const agora = new Date('2026-08-10T12:00:00.000Z');
    const provider = criarFake({ now: () => agora, toleranciaSegundos: 300 });
    const criada = await provider.createCharge(
      entradaDeCobranca({ paymentMethodToken: FAKE_TOKENS.PROCESSING }),
    );
    const request = provider.construirWebhook({
      providerRef: criada.providerRef,
      eventType: 'payment.succeeded',
    });

    const original = request.headers[FAKE_SIGNATURE_HEADER] as string;
    const timestampOriginal = Number(original.split(',')[0].replace('t=', ''));
    const hmac = original.split('v1=')[1];

    // +60s: DIFERENTE do original (senao o cabecalho seria identico e nada
    // seria testado) e DENTRO da tolerancia de 300s (senao o erro viria da
    // janela de tempo). Assim a unica causa possivel e o HMAC nao cobrir o
    // novo timestamp.
    let capturado: unknown;
    try {
      provider.verifyWebhook({
        ...request,
        headers: { [FAKE_SIGNATURE_HEADER]: `t=${timestampOriginal + 60},v1=${hmac}` },
      });
    } catch (erro) {
      capturado = erro;
    }

    expect(capturado).toBeInstanceOf(WebhookSignatureError);
    expect((capturado as Error).message).toContain('assinatura nao confere');
  });
});

// ==========================================================
// Transicoes assincronas — estado interno e webhook coerentes
// ==========================================================

describe('FakeProvider — simularTransicao', () => {
  async function emProcessamento(provider: FakeProvider, amountCents = 1000) {
    const r = await provider.createCharge(
      entradaDeCobranca({ amountCents, paymentMethodToken: FAKE_TOKENS.PROCESSING }),
    );
    return r.providerRef;
  }

  it('payment.succeeded captura o valor e o snapshot reflete', async () => {
    const provider = criarFake();
    const ref = await emProcessamento(provider, 12990);

    const evento = provider.verifyWebhook(
      provider.simularTransicao({ providerRef: ref, eventType: 'payment.succeeded' }),
    );

    expect(evento.eventType).toBe('payment.succeeded');
    if (evento.eventType !== 'payment.succeeded') throw new Error('evento inesperado');
    expect(evento.state).toBe('SUCCEEDED');
    expect(evento.capturedAmountCents).toBe(12990);

    const snapshot = await provider.getCharge(ref);
    expect(snapshot.state).toBe('SUCCEEDED');
    expect(snapshot.capturedAmountCents).toBe(12990);
  });

  it('payment.failed recusa e nao captura nada', async () => {
    const provider = criarFake();
    const ref = await emProcessamento(provider);

    const evento = provider.verifyWebhook(
      provider.simularTransicao({
        providerRef: ref,
        eventType: 'payment.failed',
        declineCode: 'expired_card',
      }),
    );

    expect(evento.eventType).toBe('payment.failed');
    if (evento.eventType !== 'payment.failed') throw new Error('evento inesperado');
    expect(evento.state).toBe('DECLINED');
    expect(evento.declineCode).toBe('expired_card');

    const snapshot = await provider.getCharge(ref);
    expect(snapshot.state).toBe('DECLINED');
    expect(snapshot.capturedAmountCents).toBe(0);
  });

  it('payment.canceled cancela e o snapshot reflete', async () => {
    const provider = criarFake();
    const ref = await emProcessamento(provider);

    const evento = provider.verifyWebhook(
      provider.simularTransicao({ providerRef: ref, eventType: 'payment.canceled' }),
    );

    expect(evento.eventType).toBe('payment.canceled');
    expect((await provider.getCharge(ref)).state).toBe('CANCELED');
  });

  it('refund.succeeded acumula no snapshot', async () => {
    const provider = criarFake();
    const ref = await emProcessamento(provider, 10000);
    provider.simularTransicao({ providerRef: ref, eventType: 'payment.succeeded' });

    const evento = provider.verifyWebhook(
      provider.simularTransicao({
        providerRef: ref,
        eventType: 'refund.succeeded',
        refundAmountCents: 3000,
      }),
    );

    expect(evento.eventType).toBe('refund.succeeded');
    if (evento.eventType !== 'refund.succeeded') throw new Error('evento inesperado');
    expect(evento.refundedAmountCents).toBe(3000);

    expect((await provider.getCharge(ref)).refundedAmountCents).toBe(3000);
  });

  it('recusa transicao impossivel: reembolsar cobranca nao capturada', async () => {
    const provider = criarFake();
    const ref = await emProcessamento(provider);

    expect(() =>
      provider.simularTransicao({ providerRef: ref, eventType: 'refund.succeeded' }),
    ).toThrow(ProviderInvalidRequestError);
  });

  it('recusa transicao impossivel: cancelar cobranca capturada', async () => {
    const provider = criarFake();
    const criada = await provider.createCharge(entradaDeCobranca());

    expect(() =>
      provider.simularTransicao({
        providerRef: criada.providerRef,
        eventType: 'payment.canceled',
      }),
    ).toThrow(ProviderInvalidRequestError);
  });

  it('construirWebhook deriva estado COERENTE do tipo do evento', async () => {
    const provider = criarFake();
    const ref = await emProcessamento(provider);

    // A cobranca esta em PROCESSING, mas o evento e payment.succeeded: o corpo
    // deve sair com SUCCEEDED, nao com o estado atual. Era o bug apontado no
    // review — fixture que anunciava uma transicao e carregava outra.
    const evento = provider.verifyWebhook(
      provider.construirWebhook({ providerRef: ref, eventType: 'payment.succeeded' }),
    );

    expect(evento.eventType).toBe('payment.succeeded');
    if (evento.eventType !== 'payment.succeeded') throw new Error('evento inesperado');
    expect(evento.state).toBe('SUCCEEDED');
  });
});

// ==========================================================
// Assinatura valida NAO implica conteudo valido
// ==========================================================

describe('FakeProvider — payload assinado e semanticamente invalido', () => {
  function corpo(
    raiz: Record<string, unknown> = {},
    dados: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: 'evt_teste',
      type: 'payment.succeeded',
      created_at: '2026-08-10T12:00:00.000Z',
      ...raiz,
      data: {
        charge_ref: 'ch_teste',
        state: 'SUCCEEDED',
        captured_amount_cents: 1000,
        refunded_amount_cents: 0,
        decline_code: null,
        ...dados,
      },
    };
  }

  it('sanidade: o corpo base e aceito', () => {
    const provider = criarFake();
    const evento = provider.verifyWebhook(provider.assinarCorpo(corpo()));

    expect(evento.eventType).toBe('payment.succeeded');
    expect(evento.providerEventId).toBe('evt_teste');
    expect(evento.providerRef).toBe('ch_teste');
  });

  it.each([
    ['id ausente', { id: undefined }, {}],
    ['id vazio', { id: '   ' }, {}],
    ['id nao string', { id: 42 }, {}],
    ['id longo demais', { id: 'x'.repeat(256) }, {}],
    ['type ausente', { type: undefined }, {}],
    ['type vazio', { type: '' }, {}],
    ['created_at numerico', { created_at: 1723291200 }, {}],
    ['created_at fora de ISO-8601', { created_at: '10/08/2026' }, {}],
  ])('recusa %s', (_rotulo, raiz, dados) => {
    const provider = criarFake();
    const request = provider.assinarCorpo(corpo(raiz, dados));

    expect(() => provider.verifyWebhook(request)).toThrow(ProviderInvalidRequestError);
  });

  it.each([
    ['data ausente', { data: undefined }],
    ['data nao objeto', { data: 'texto' }],
    ['data array', { data: [] }],
  ])('recusa %s', (_rotulo, raiz) => {
    const provider = criarFake();
    const request = provider.assinarCorpo({ ...corpo(), ...raiz });

    expect(() => provider.verifyWebhook(request)).toThrow(ProviderInvalidRequestError);
  });

  it.each([
    ['charge_ref vazio', { charge_ref: '' }],
    ['state desconhecido', { state: 'PAID' }],
    ['state nao string', { state: 7 }],
    ['captured negativo', { captured_amount_cents: -1 }],
    ['captured fracionario', { captured_amount_cents: 1.5 }],
    ['captured string', { captured_amount_cents: '1000' }],
    ['captured null', { captured_amount_cents: null }],
    ['captured fora do inteiro seguro', { captured_amount_cents: Number.MAX_SAFE_INTEGER + 2 }],
    ['captured acima do teto', { captured_amount_cents: MAX_AMOUNT_CENTS + 1 }],
    ['refunded negativo', { refunded_amount_cents: -1 }],
    ['decline_code nao string', { decline_code: 99 }],
  ])('recusa %s', (_rotulo, dados) => {
    const provider = criarFake();
    const request = provider.assinarCorpo(corpo({}, dados));

    expect(() => provider.verifyWebhook(request)).toThrow(ProviderInvalidRequestError);
  });

  it.each([
    ['payment.succeeded com state PROCESSING', 'payment.succeeded', { state: 'PROCESSING' }],
    ['payment.succeeded sem valor capturado', 'payment.succeeded', { captured_amount_cents: 0 }],
    ['payment.succeeded com reembolsado > capturado', 'payment.succeeded', { captured_amount_cents: 100, refunded_amount_cents: 101 }],
    ['payment.failed com state SUCCEEDED', 'payment.failed', { state: 'SUCCEEDED' }],
    ['payment.failed com valor capturado', 'payment.failed', { state: 'DECLINED', captured_amount_cents: 500 }],
    ['payment.canceled com state PROCESSING', 'payment.canceled', { state: 'PROCESSING' }],
    ['payment.canceled com valor capturado', 'payment.canceled', { state: 'CANCELED', captured_amount_cents: 500 }],
    ['refund.succeeded sem valor reembolsado', 'refund.succeeded', { refunded_amount_cents: 0 }],
  ])('recusa incoerencia: %s', (_rotulo, type, dados) => {
    const provider = criarFake();
    const request = provider.assinarCorpo(corpo({ type }, dados));

    expect(() => provider.verifyWebhook(request)).toThrow(ProviderInvalidRequestError);
  });

  it('recusa corpo que nao e JSON, mesmo com assinatura valida', () => {
    const provider = criarFake();

    expect(() => provider.verifyWebhook(provider.assinarCorpo('nao-e-json'))).toThrow(
      ProviderInvalidRequestError,
    );
  });

  it('recusa corpo que e array em vez de objeto', () => {
    const provider = criarFake();

    expect(() => provider.verifyWebhook(provider.assinarCorpo([1, 2, 3]))).toThrow(
      ProviderInvalidRequestError,
    );
  });
});

describe('FakeProvider — traducao do payload', () => {
  it('marca como unsupported o tipo de evento que nao tratamos', () => {
    const provider = criarFake();
    const request = provider.assinarCorpo({
      id: 'evt_x',
      type: 'invoice.finalized',
      created_at: '2026-08-10T12:00:00.000Z',
      data: {
        charge_ref: 'ch_x',
        state: 'PROCESSING',
        captured_amount_cents: 0,
        refunded_amount_cents: 0,
        decline_code: null,
      },
    });

    const evento = provider.verifyWebhook(request);
    expect(evento.eventType).toBe('unsupported');

    // A uniao discriminada NAO da estado a evento nao suportado: nao conhecemos
    // a semantica, e o tipo impede o handler de usar dado que nao sabe ler.
    expect('state' in evento).toBe(false);
  });

  it('preserva providerCreatedAt quando o provedor informa', () => {
    const provider = criarFake();
    const request = provider.assinarCorpo({
      id: 'evt_y',
      type: 'payment.canceled',
      created_at: '2026-08-10T11:59:00.000Z',
      data: {
        charge_ref: 'ch_y',
        state: 'CANCELED',
        captured_amount_cents: 0,
        refunded_amount_cents: 0,
        decline_code: null,
      },
    });

    expect(provider.verifyWebhook(request).providerCreatedAt).toEqual(
      new Date('2026-08-10T11:59:00.000Z'),
    );
  });

  it('devolve providerCreatedAt null quando o provedor nao informa', () => {
    const provider = criarFake();
    const request = provider.assinarCorpo({
      id: 'evt_z',
      type: 'payment.canceled',
      created_at: null,
      data: {
        charge_ref: 'ch_z',
        state: 'CANCELED',
        captured_amount_cents: 0,
        refunded_amount_cents: 0,
        decline_code: null,
      },
    });

    expect(provider.verifyWebhook(request).providerCreatedAt).toBeNull();
  });

  it('guarda o payload original em raw, para o inbox', async () => {
    const provider = criarFake();
    const criada = await provider.createCharge(
      entradaDeCobranca({ paymentMethodToken: FAKE_TOKENS.PROCESSING }),
    );
    const request = provider.simularTransicao({
      providerRef: criada.providerRef,
      eventType: 'payment.succeeded',
    });

    const evento = provider.verifyWebhook(request);
    expect(evento.raw).toEqual(JSON.parse(request.rawBody.toString('utf8')));
  });
});
