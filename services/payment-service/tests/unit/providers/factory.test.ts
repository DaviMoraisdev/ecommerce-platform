import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../../../src/config/env';
import { criarPaymentProvider, ProviderNaoImplementadoError } from '../../../src/providers/factory';
import { FakeProvider } from '../../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../../src/providers/fake/fake.tokens';
import { WebhookSignatureError } from '../../../src/providers/payment-provider.port';

const SEGREDO_A = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666';
const SEGREDO_B = '6666ffff5555eeee4444dddd3333cccc2222bbbb1111aaaa';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3007,
    databaseUrl: 'postgresql://u:p@127.0.0.1:5432/payment_db',
    defaultCurrency: 'BRL',
    nodeEnv: 'test',
    provider: 'fake',
    webhookSecret: SEGREDO_A,
    jwtSecret: SEGREDO_A,
    ...overrides,
  };
}

function entradaDeCobranca() {
  return {
    amountCents: 1000,
    currency: 'BRL' as const,
    paymentMethodToken: FAKE_TOKENS.PROCESSING,
    idempotencyKey: randomUUID(),
    reference: { paymentId: randomUUID(), orderId: randomUUID() },
  };
}

describe('criarPaymentProvider', () => {
  it('constroi o FakeProvider quando o provedor e fake', () => {
    const provider = criarPaymentProvider(config({ provider: 'fake' }));

    expect(provider).toBeInstanceOf(FakeProvider);
    expect(provider.name).toBe('fake');
  });

  it('lanca ProviderNaoImplementadoError para stripe, com a fase de destino', () => {
    expect(() => criarPaymentProvider(config({ provider: 'stripe' }))).toThrow(
      ProviderNaoImplementadoError,
    );
    expect(() => criarPaymentProvider(config({ provider: 'stripe' }))).toThrow(/Bloco 9/);
  });

  /**
   * Este e o teste que discrimina. Sem ele, uma fabrica que ignorasse
   * config.webhookSecret e usasse um valor fixo passaria em todos os outros —
   * dois providers construidos com segredos diferentes aceitariam o mesmo
   * webhook, e a configuracao seria decorativa.
   */
  it('entrega ao provider o segredo VINDO DA CONFIG, nao um valor fixo', async () => {
    const a = criarPaymentProvider(config({ webhookSecret: SEGREDO_A })) as FakeProvider;
    const b = criarPaymentProvider(config({ webhookSecret: SEGREDO_B })) as FakeProvider;

    const cobranca = await a.createCharge(entradaDeCobranca());
    const webhookDeA = a.construirWebhook({
      providerRef: cobranca.providerRef,
      eventType: 'payment.succeeded',
    });

    expect(() => a.verifyWebhook(webhookDeA)).not.toThrow();
    expect(() => b.verifyWebhook(webhookDeA)).toThrow(WebhookSignatureError);
  });

  it('cada chamada devolve uma instancia nova, sem estado compartilhado', async () => {
    const primeiro = criarPaymentProvider(config()) as FakeProvider;
    const segundo = criarPaymentProvider(config()) as FakeProvider;

    const cobranca = await primeiro.createCharge(entradaDeCobranca());

    // A cobranca existe no primeiro e nao no segundo.
    await expect(primeiro.getCharge(cobranca.providerRef)).resolves.toBeDefined();
    await expect(segundo.getCharge(cobranca.providerRef)).rejects.toThrow();
  });
});
