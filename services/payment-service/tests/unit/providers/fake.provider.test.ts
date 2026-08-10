import { randomUUID } from 'node:crypto';

import {
  ProviderAuthenticationError,
  ProviderInvalidRequestError,
  ProviderUnavailableError,
  WebhookSignatureError,
  type PaymentProvider,
} from '../../../src/providers/payment-provider.port';
import { FakeProvider, FAKE_SIGNATURE_HEADER } from '../../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../../src/providers/fake/fake.tokens';
import { rodarContratoDeProvedor } from './payment-provider.contract';

const SEGREDO = 'segredo-de-teste-do-fake';

function criarFake(overrides: Partial<{ now: () => Date; toleranciaSegundos: number }> = {}) {
  return new FakeProvider({ webhookSecret: SEGREDO, ...overrides });
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
  assinarWebhook: (provider: PaymentProvider, input) =>
    (provider as FakeProvider).construirWebhook({
      providerRef: input.providerRef,
      eventType: input.eventType,
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
});

describe('FakeProvider — mapeamento de erro tecnico', () => {
  function cobrar(provider: FakeProvider, token: string) {
    return provider.createCharge({
      amountCents: 1000,
      currency: 'BRL',
      paymentMethodToken: token,
      idempotencyKey: randomUUID(),
      reference: { paymentId: randomUUID(), orderId: randomUUID() },
    });
  }

  it.each([
    [FAKE_TOKENS.ERROR_UNAVAILABLE, ProviderUnavailableError, true],
    [FAKE_TOKENS.ERROR_INVALID, ProviderInvalidRequestError, false],
    [FAKE_TOKENS.ERROR_AUTHENTICATION, ProviderAuthenticationError, false],
  ])('%s produz %p com retryable=%p', async (token, classe, retryable) => {
    const provider = criarFake();

    await expect(cobrar(provider, token)).rejects.toBeInstanceOf(classe);

    try {
      await cobrar(provider, token);
    } catch (erro) {
      expect((erro as { retryable: boolean }).retryable).toBe(retryable);
    }
  });

  it('erro tecnico NAO consome a chave de idempotencia — retentar pode suceder', async () => {
    const provider = criarFake();
    const idempotencyKey = randomUUID();
    const base = {
      amountCents: 1000,
      currency: 'BRL' as const,
      idempotencyKey,
      reference: { paymentId: randomUUID(), orderId: randomUUID() },
    };

    await expect(
      provider.createCharge({ ...base, paymentMethodToken: FAKE_TOKENS.ERROR_UNAVAILABLE }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    // Se a chave tivesse sido consumida, esta chamada devolveria uma cobranca
    // inexistente e o pagamento ficaria preso para sempre.
    const r = await provider.createCharge({
      ...base,
      paymentMethodToken: FAKE_TOKENS.SUCCESS,
    });
    expect(r.state).toBe('SUCCEEDED');
  });

  it.each([
    [FAKE_TOKENS.DECLINED_INSUFFICIENT_FUNDS, 'insufficient_funds'],
    [FAKE_TOKENS.DECLINED_EXPIRED_CARD, 'expired_card'],
    [FAKE_TOKENS.DECLINED_FRAUD, 'fraudulent'],
  ])('%s recusa com declineCode %s', async (token, codigo) => {
    const provider = criarFake();
    const r = await cobrar(provider, token);

    expect(r.state).toBe('DECLINED');
    expect(r.declineCode).toBe(codigo);
    expect(typeof r.declineMessage).toBe('string');
  });
});

describe('FakeProvider — verificacao de assinatura', () => {
  function cobrancaEmProcessamento(provider: FakeProvider) {
    return provider.createCharge({
      amountCents: 1000,
      currency: 'BRL',
      paymentMethodToken: FAKE_TOKENS.PROCESSING,
      idempotencyKey: randomUUID(),
      reference: { paymentId: randomUUID(), orderId: randomUUID() },
    });
  }

  it('recusa assinatura feita com outro segredo', async () => {
    const provider = criarFake();
    const { providerRef } = await cobrancaEmProcessamento(provider);

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
  ])('recusa cabecalho malformado: %s', async (_rotulo, valor) => {
    const provider = criarFake();
    const { providerRef } = await cobrancaEmProcessamento(provider);
    const request = provider.construirWebhook({ providerRef, eventType: 'payment.succeeded' });

    expect(() =>
      provider.verifyWebhook({
        ...request,
        headers: { [FAKE_SIGNATURE_HEADER]: valor },
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('aceita o cabecalho independente de caixa', async () => {
    const provider = criarFake();
    const { providerRef } = await cobrancaEmProcessamento(provider);
    const request = provider.construirWebhook({ providerRef, eventType: 'payment.succeeded' });

    const valor = request.headers[FAKE_SIGNATURE_HEADER] as string;

    expect(() =>
      provider.verifyWebhook({ ...request, headers: { 'X-Fake-Signature': valor } }),
    ).not.toThrow();
  });

  it('REPLAY: recusa evento fora da janela de tolerancia', async () => {
    const agora = new Date('2026-08-10T12:00:00.000Z');
    const provider = criarFake({ now: () => agora, toleranciaSegundos: 300 });
    const { providerRef } = await cobrancaEmProcessamento(provider);

    const antigo = Math.floor(agora.getTime() / 1000) - 301;
    const request = provider.construirWebhook({
      providerRef,
      eventType: 'payment.succeeded',
      timestampSegundos: antigo,
    });

    expect(() => provider.verifyWebhook(request)).toThrow(/tolerancia/);
  });

  it('aceita evento no limite exato da tolerancia', async () => {
    const agora = new Date('2026-08-10T12:00:00.000Z');
    const provider = criarFake({ now: () => agora, toleranciaSegundos: 300 });
    const { providerRef } = await cobrancaEmProcessamento(provider);

    const request = provider.construirWebhook({
      providerRef,
      eventType: 'payment.succeeded',
      timestampSegundos: Math.floor(agora.getTime() / 1000) - 300,
    });

    expect(() => provider.verifyWebhook(request)).not.toThrow();
  });

  it('REPLAY: trocar o timestamp do cabecalho invalida a assinatura', async () => {
    const agora = new Date('2026-08-10T12:00:00.000Z');
    const provider = criarFake({ now: () => agora, toleranciaSegundos: 300 });
    const { providerRef } = await cobrancaEmProcessamento(provider);
    const request = provider.construirWebhook({ providerRef, eventType: 'payment.succeeded' });

    const original = request.headers[FAKE_SIGNATURE_HEADER] as string;
    const timestampOriginal = Number(original.split(',')[0].replace('t=', ''));
    const hmac = original.split('v1=')[1];

    // +60s: DIFERENTE do original (senao o cabecalho seria identico e nada
    // seria testado) e DENTRO da tolerancia de 300s (senao o erro viria da
    // janela de tempo, nao da assinatura). Assim a unica causa possivel de
    // falha e o HMAC nao cobrir o novo timestamp.
    const novoTimestamp = timestampOriginal + 60;

    let capturado: unknown;
    try {
      provider.verifyWebhook({
        ...request,
        headers: { [FAKE_SIGNATURE_HEADER]: `t=${novoTimestamp},v1=${hmac}` },
      });
    } catch (erro) {
      capturado = erro;
    }

    expect(capturado).toBeInstanceOf(WebhookSignatureError);
    // Asercao sobre a MENSAGEM: uma falha de tolerancia nao satisfaz o teste.
    expect((capturado as Error).message).toContain('assinatura nao confere');
  });
});

describe('FakeProvider — traducao do payload', () => {
  async function comCobranca() {
    const provider = criarFake();
    const criada = await provider.createCharge({
      amountCents: 1000,
      currency: 'BRL',
      paymentMethodToken: FAKE_TOKENS.PROCESSING,
      idempotencyKey: randomUUID(),
      reference: { paymentId: randomUUID(), orderId: randomUUID() },
    });
    return { provider, providerRef: criada.providerRef };
  }

  it('marca como unsupported o tipo de evento que nao tratamos', async () => {
    const { provider, providerRef } = await comCobranca();
    const request = provider.construirWebhook({
      providerRef,
      eventType: 'invoice.finalized',
    });

    expect(provider.verifyWebhook(request).eventType).toBe('unsupported');
  });

  it('preserva providerCreatedAt quando o provedor informa', async () => {
    const { provider, providerRef } = await comCobranca();
    const criadoEm = new Date('2026-08-10T11:59:00.000Z');
    const request = provider.construirWebhook({
      providerRef,
      eventType: 'payment.succeeded',
      providerCreatedAt: criadoEm,
    });

    expect(provider.verifyWebhook(request).providerCreatedAt).toEqual(criadoEm);
  });

  it('devolve providerCreatedAt null quando o provedor nao informa', async () => {
    const { provider, providerRef } = await comCobranca();
    const request = provider.construirWebhook({
      providerRef,
      eventType: 'payment.succeeded',
      providerCreatedAt: null,
    });

    expect(provider.verifyWebhook(request).providerCreatedAt).toBeNull();
  });

  it('guarda o payload original em raw, para o inbox', async () => {
    const { provider, providerRef } = await comCobranca();
    const request = provider.construirWebhook({
      providerRef,
      eventType: 'payment.succeeded',
    });

    const evento = provider.verifyWebhook(request);
    expect(evento.raw).toEqual(JSON.parse(request.rawBody.toString('utf8')));
  });

  it('recusa corpo que nao e JSON, mesmo com assinatura valida', async () => {
    const provider = criarFake();
    const rawBody = Buffer.from('nao-e-json', 'utf8');
    const timestamp = Math.floor(Date.now() / 1000);

    // Assina o corpo invalido com o segredo correto: a assinatura confere,
    // e a falha tem de vir da desserializacao, nao da verificacao.
    const { createHmac } = await import('node:crypto');
    const hmac = createHmac('sha256', SEGREDO)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]))
      .digest('hex');

    expect(() =>
      provider.verifyWebhook({
        rawBody,
        headers: { [FAKE_SIGNATURE_HEADER]: `t=${timestamp},v1=${hmac}` },
      }),
    ).toThrow(ProviderInvalidRequestError);
  });
});
