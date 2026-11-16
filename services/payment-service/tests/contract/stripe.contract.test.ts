import Stripe from 'stripe';

import { randomUUID } from 'node:crypto';

import type { PaymentProvider, WebhookRequest } from '../../src/providers/payment-provider.port';
import { StripeProvider } from '../../src/providers/stripe/stripe.provider';
import { rodarContratoDeProvedor } from '../unit/providers/payment-provider.contract';

/**
 * A MESMA suite de contrato que o FakeProvider cumpre, agora contra a Stripe
 * real (sandbox). Se os dois passarem, os Blocos 3 a 8 de fato nao precisam
 * saber qual provedor esta ativo.
 *
 * Roda SO por `npm run test:contract`, que carrega o .env.contract.
 */

const CHAVE = process.env.STRIPE_SECRET_KEY ?? '';

// Sem chave a suite FALHA, nao pula: pular em silencio seria falso verde.
if (CHAVE === '') {
  throw new Error(
    'STRIPE_SECRET_KEY ausente. Rode com `npm run test:contract`, que carrega o .env.contract.',
  );
}

// Esta suite CRIA cobrancas e reembolsos. Com chave live por engano, rodar o
// contrato moveria dinheiro de verdade. O valor da chave nao e ecoado.
if (!/^(sk|rk|rkcs)_test_/.test(CHAVE)) {
  throw new Error('A suite de contrato so roda com chave de TESTE (sk_test_, rk_test_ ou rkcs_test_).');
}

/** So para assinar localmente: a entrega REAL de webhook (stripe listen) e outro incremento. */
const SEGREDO_LOCAL = 'whsec_contrato_local_9c';

const TIPO_NA_STRIPE: Record<string, string> = {
  'payment.succeeded': 'payment_intent.succeeded',
};

/**
 * O contrato exige este hook de forma SINCRONA, entao o evento e montado aqui e
 * assinado com o HMAC real do SDK. Isso prova a NOSSA verificacao, nao a entrega
 * da Stripe — declarado, nao escondido.
 */
function assinarWebhook(
  _provider: PaymentProvider,
  input: { providerRef: string; eventType: string },
): WebhookRequest {
  const tipo = TIPO_NA_STRIPE[input.eventType];
  if (tipo === undefined) {
    throw new Error(
      `kit da Stripe ainda nao sabe assinar "${input.eventType}" — limite do KIT, nao do adapter`,
    );
  }
  const payload = JSON.stringify({
    id: `evt_contrato_${Date.now()}`,
    object: 'event',
    type: tipo,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: input.providerRef, object: 'payment_intent', amount_received: 12990 } },
  });
  return {
    rawBody: Buffer.from(payload),
    headers: {
      'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: SEGREDO_LOCAL }),
    },
  };
}

function tipoBrutoDe(eventType: string): string {
  const tipo = TIPO_NA_STRIPE[eventType];
  if (tipo === undefined) {
    throw new Error(`kit da Stripe nao conhece o tipo bruto de "${eventType}" — limite do KIT`);
  }
  return tipo;
}

rodarContratoDeProvedor({
  nome: 'StripeProvider (sandbox real)',
  criar: () => new StripeProvider({ secretKey: CHAVE, webhookSecret: SEGREDO_LOCAL }),
  tokens: {
    sucesso: 'pm_card_visa',
    // 3D Secure obrigatorio: o intent fica em requires_action, que o mapeamento
    // traduz para PROCESSING.
    processando: 'pm_card_threeDSecure2Required',
    recusado: 'pm_card_visa_chargeDeclined',
    desconhecido: 'pm_inexistente_contrato_9c',
  },
  // Lacunas DECLARADAS, visiveis em review — o contrato existe para isso.
  capacidades: {
    // API real nao oferece falha transiente sob comando.
    falhaTransiente: false,
    // Completar 3D Secure exige navegador; nao ha PROCESSING -> SUCCEEDED controlavel.
    transicaoAssincrona: false,
    // Nao ha gatilho deterministico para "cobranca criada e resposta perdida".
    falhaAmbigua: false,
  },
  assinarWebhook,
  tipoBrutoDe,
});

describe('StripeProvider — payload REAL de charge.refunded (9c)', () => {
  it(
    'evento lido do sandbox passa pelo verifyWebhook e entrega so os TOTAIS, sem id adivinhado',
    async () => {
      // Unico teste que exercita o formato que a Stripe REALMENTE envia — a falta
      // dele e o que deixou o bug do refunds passar pelo 9b inteiro.
      const provider = new StripeProvider({ secretKey: CHAVE, webhookSecret: SEGREDO_LOCAL });
      const cobranca = await provider.createCharge({
        amountCents: 12990,
        currency: 'BRL',
        paymentMethodToken: 'pm_card_visa',
        idempotencyKey: randomUUID(),
        reference: { paymentId: randomUUID(), orderId: randomUUID(), attemptCount: 1 },
      });
      // Margem de 60 s contra desvio entre o relogio local e o da Stripe.
      const antesDoReembolso = Math.floor(Date.now() / 1000) - 60;
      await provider.refund({
        providerRef: cobranca.providerRef,
        amountCents: 3000,
        idempotencyKey: randomUUID(),
      });

      // O evento e assincrono. PRAZO TOTAL, e nao contador — o contador limitava
      // consultas, nao a duracao de cada uma (review do PR #78, F2). Timeout curto
      // no cliente, para uma requisicao pendurada nao sobreviver ao teste. Filtro
      // por `created` com paginacao, para o evento nao ficar fora dos primeiros
      // itens quando houver atividade concorrente na conta.
      const stripe = new Stripe(CHAVE, { timeout: 5_000, maxNetworkRetries: 0 });
      const prazo = Date.now() + 40_000;
      let real: Stripe.Event | undefined;
      while (real === undefined && Date.now() < prazo) {
        for await (const e of stripe.events.list({
          type: 'charge.refunded',
          created: { gte: antesDoReembolso },
          limit: 100,
        })) {
          if ((e.data.object as { payment_intent?: string }).payment_intent === cobranca.providerRef) {
            real = e;
            break;
          }
        }
        if (real === undefined) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(real).toBeDefined();

      const payload = JSON.stringify(real);
      const evento = provider.verifyWebhook({
        rawBody: Buffer.from(payload),
        headers: {
          'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: SEGREDO_LOCAL }),
        },
      });

      expect(evento).toMatchObject({
        eventType: 'refund.succeeded',
        providerRef: cobranca.providerRef,
        state: 'SUCCEEDED',
        capturedAmountCents: 12990,
        refundedAmountCents: 3000,
      });
      expect('providerRefundRef' in evento).toBe(false);
    },
    60_000,
  );
});
