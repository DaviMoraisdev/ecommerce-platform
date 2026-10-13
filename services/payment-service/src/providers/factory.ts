import type { AppConfig } from '../config/env';
import { FakeProvider } from './fake/fake.provider';
import { StripeProvider } from './stripe/stripe.provider';
import type { PaymentProvider } from './payment-provider.port';

/**
 * A CONFIG valida a intencao; a FABRICA valida a capacidade.
 *
 * O `env.ts` ja recusou `PAYMENT_PROVIDER=fake` fora de development/test — isso
 * e controle de seguranca e tem de disparar no boot, antes de qualquer objeto
 * existir. Aqui a pergunta e outra: existe adapter para o provedor pedido?
 *
 * Separar as duas evita que um boot em producao passe por um caminho de teste, e
 * ao mesmo tempo permite que `PAYMENT_PROVIDER=stripe` seja configuracao valida
 * antes do adapter existir — falhando de forma clara em vez de silenciosa.
 */
/**
 * Provedor existe, mas a configuracao nao permite construi-lo.
 *
 * Classe propria: a diferenca entre "nao ha adapter" e "o adapter existe e
 * falta credencial" muda o que o operador faz. Ate o 9b-2 existia tambem um
 * ProviderNaoImplementadoError, removido quando o caso stripe passou a
 * construir de verdade — classe de erro sem produtor sugere comportamento que
 * nao existe mais.
 */
export class ProviderMalConfiguradoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderMalConfiguradoError';
  }
}

/** Prefixo do segredo de endpoint de webhook da Stripe. */
export const PREFIXO_SEGREDO_WEBHOOK_STRIPE = 'whsec_';

export function criarPaymentProvider(config: AppConfig): PaymentProvider {
  switch (config.provider) {
    case 'fake':
      // Chegar aqui implica NODE_ENV em development ou test: o env.ts garantiu.
      return new FakeProvider({ webhookSecret: config.webhookSecret });

    case 'stripe': {
      // O loadConfig ja exige a chave quando o provedor e stripe; esta guarda e
      // defesa em profundidade, porque o AppConfig tambem e montado por
      // builders de teste que nao passam pelo loadConfig.
      if (config.stripeSecretKey === null) {
        throw new ProviderMalConfiguradoError(
          'PAYMENT_PROVIDER=stripe sem STRIPE_SECRET_KEY. O boot deveria ter recusado antes daqui.',
        );
      }

      // CAPACIDADE, nao intencao: um segredo sem whsec_ nao verifica assinatura
      // nenhuma, e todo webhook viraria 401 — falha que so apareceria em
      // producao, no primeiro evento. A mensagem nao ecoa o segredo.
      if (!config.webhookSecret.startsWith(PREFIXO_SEGREDO_WEBHOOK_STRIPE)) {
        throw new ProviderMalConfiguradoError(
          `PAYMENT_WEBHOOK_SECRET nao comeca com "${PREFIXO_SEGREDO_WEBHOOK_STRIPE}": ` +
            'com a Stripe, esse e o segredo do endpoint de webhook, e sem ele toda ' +
            'entrega seria recusada com 401.',
        );
      }

      return new StripeProvider({
        secretKey: config.stripeSecretKey,
        webhookSecret: config.webhookSecret,
      });
    }
  }
}
