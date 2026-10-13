import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../../../src/config/env';
import { configDeTeste } from '../../helpers/config';
import Stripe from 'stripe';

import { criarPaymentProvider, ProviderMalConfiguradoError } from '../../../src/providers/factory';
import { StripeProvider } from '../../../src/providers/stripe/stripe.provider';
import { FakeProvider } from '../../../src/providers/fake/fake.provider';
import { FAKE_TOKENS } from '../../../src/providers/fake/fake.tokens';
import { WebhookSignatureError } from '../../../src/providers/payment-provider.port';

const SEGREDO_A = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666';
const SEGREDO_B = '6666ffff5555eeee4444dddd3333cccc2222bbbb1111aaaa';
const WHSEC_A = 'whsec_aaaa1111bbbb2222cccc3333dddd4444';
const WHSEC_B = 'whsec_bbbb2222cccc3333dddd4444eeee5555';
const CHAVE_STRIPE = 'sk_test_FALSA_PARA_TESTE_000';

/** Config coerente de Stripe: chave secreta presente e segredo com whsec_. */
function configStripe(overrides: Partial<AppConfig> = {}): AppConfig {
  return config({
    provider: 'stripe',
    stripeSecretKey: CHAVE_STRIPE,
    webhookSecret: WHSEC_A,
    ...overrides,
  });
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return configDeTeste({ webhookSecret: SEGREDO_A, jwtSecret: SEGREDO_A, ...overrides });
}

function entradaDeCobranca() {
  return {
    amountCents: 1000,
    currency: 'BRL' as const,
    paymentMethodToken: FAKE_TOKENS.PROCESSING,
    idempotencyKey: randomUUID(),
    reference: { paymentId: randomUUID(), orderId: randomUUID(), attemptCount: 1 },
  };
}

describe('criarPaymentProvider', () => {
  it('constroi o FakeProvider quando o provedor e fake', () => {
    const provider = criarPaymentProvider(config({ provider: 'fake' }));

    expect(provider).toBeInstanceOf(FakeProvider);
    expect(provider.name).toBe('fake');
  });

  it('F1: constroi o StripeProvider quando o provedor e stripe', () => {
    const provider = criarPaymentProvider(configStripe());

    expect(provider).toBeInstanceOf(StripeProvider);
    expect(provider.name).toBe('stripe');
    // A Stripe nao prova ausencia por consulta (decisao do 9b-1).
    expect(provider.ausenciaEDefinitiva).toBe(false);
  });

  it('F2: entrega a Stripe o segredo de webhook VINDO DA CONFIG', () => {
    // Mesmo criterio do teste discriminante do fake: com a Stripe nao da para
    // inspecionar o segredo por dentro, so pelo comportamento. Um evento
    // assinado com WHSEC_A tem de passar em A e falhar em B.
    const a = criarPaymentProvider(configStripe({ webhookSecret: WHSEC_A }));
    const b = criarPaymentProvider(configStripe({ webhookSecret: WHSEC_B }));

    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'payment_intent.canceled',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'pi_1', object: 'payment_intent' } },
    });
    const requisicao = {
      rawBody: Buffer.from(payload, 'utf8'),
      headers: {
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC_A }),
      },
    };

    expect(() => a.verifyWebhook(requisicao)).not.toThrow();
    expect(() => b.verifyWebhook(requisicao)).toThrow(WebhookSignatureError);
  });

  it('F3: stripe sem STRIPE_SECRET_KEY e configuracao invalida, nao adapter ausente', () => {
    expect(() => criarPaymentProvider(configStripe({ stripeSecretKey: null }))).toThrow(
      ProviderMalConfiguradoError,
    );
  });

  it('F4: segredo de webhook sem whsec_ recusa no boot, sem ecoar o segredo', () => {
    const segredoErrado = SEGREDO_B;
    let mensagem = '';
    try {
      criarPaymentProvider(configStripe({ webhookSecret: segredoErrado }));
    } catch (erro) {
      mensagem = erro instanceof Error ? erro.message : String(erro);
    }

    expect(mensagem).toContain('whsec_');
    expect(mensagem).not.toContain(segredoErrado);
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
