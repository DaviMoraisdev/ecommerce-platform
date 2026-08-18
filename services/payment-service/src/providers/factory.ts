import type { AppConfig } from '../config/env';
import { FakeProvider } from './fake/fake.provider';
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
export class ProviderNaoImplementadoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNaoImplementadoError';
  }
}

export function criarPaymentProvider(config: AppConfig): PaymentProvider {
  switch (config.provider) {
    case 'fake':
      // Chegar aqui implica NODE_ENV em development ou test: o env.ts garantiu.
      return new FakeProvider({ webhookSecret: config.webhookSecret });

    case 'stripe':
      throw new ProviderNaoImplementadoError(
        'Adapter da Stripe entra no Bloco 9. Use PAYMENT_PROVIDER=fake em desenvolvimento.',
      );
  }
}
