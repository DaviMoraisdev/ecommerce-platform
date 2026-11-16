import Stripe from 'stripe';

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
});
