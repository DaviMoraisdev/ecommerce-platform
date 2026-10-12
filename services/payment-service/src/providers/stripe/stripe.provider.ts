import Stripe from 'stripe';

import {
  ProviderInvalidRequestError,
  type ChargeResult,
  type ChargeSnapshot,
  type CancelChargeInput,
  type CreateChargeInput,
  type PaymentProvider,
  type ProviderName,
  type ProviderRef,
  type RefundInput,
  type RefundResult,
  type WebhookEventPayload,
  type WebhookRequest,
} from '../payment-provider.port';
import { lancarTraduzido } from './stripe.erros';
import { recusaDeCobranca, resultadoDaCriacao } from './stripe.mapeamento';

export interface StripeProviderDeps {
  secretKey: string;
  webhookSecret: string;
  /**
   * `fetch` injetavel, usado via Stripe.createFetchHttpClient(fetchFn).
   * Existe para o TESTE provar o FORMATO DA REQUISICAO sem tocar a rede: o
   * mapeamento da resposta ja esta provado no 9b-1, e o que ninguem tinha
   * verificado e o que sai daqui.
   */
  fetchFn?: typeof fetch;
}

/** Placeholder dos metodos que entram nos incrementos seguintes do 9b-2. */
export const PENDENTE_NO_9B2 = 'operacao do adapter da Stripe ainda nao implementada (9b-2)';

export class StripeProvider implements PaymentProvider {
  readonly name: ProviderName = 'stripe';

  /**
   * FALSE, e o 9b-1 explicou por que: a Search API da Stripe nao serve
   * read-after-write ("data is searchable in under 1 minute", pior em
   * incidente) e nenhuma consulta ve requisicao aceita e ainda nao
   * materializada. Com false, ausencia vira TRIAGEM e o pagamento continua
   * preso e visivel, que e o estado seguro do job do Bloco 6b.
   */
  readonly ausenciaEDefinitiva = false;

  private readonly stripe: Stripe;

  constructor(private readonly deps: StripeProviderDeps) {
    this.stripe = new Stripe(
      deps.secretKey,
      deps.fetchFn === undefined
        ? {}
        : { httpClient: Stripe.createFetchHttpClient(deps.fetchFn) },
    );
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    // Validacoes locais ANTES da rede, espelhando o fake: chamada que a Stripe
    // recusaria de todo jeito nao precisa custar uma ida ate lA.
    if (input.idempotencyKey.trim() === '') {
      throw new ProviderInvalidRequestError('idempotencyKey e obrigatoria');
    }
    if (input.currency !== 'BRL') {
      throw new ProviderInvalidRequestError('moeda nao suportada');
    }

    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          // ISO em MINUSCULAS: a Stripe exige lowercase.
          currency: input.currency.toLowerCase(),
          payment_method: input.paymentMethodToken,
          // Criar e confirmar na MESMA chamada. Sem isto o intent nasceria em
          // requires_payment_method e nada seria cobrado.
          confirm: true,
          // SUPOSICAO declarada: a doc do create nao diz QUANDO return_url passa
          // a ser obrigatorio. Cobranca servidor-a-servidor nao tem para onde
          // redirecionar, entao recusamos metodo com redirecionamento. Se a
          // Stripe exigir return_url mesmo assim, aparece no 9c como
          // invalid_request_error e a correcao e passar a URL.
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          // Correlacao que o job do 6b usa, e que a propria Stripe recomenda
          // para reconciliar objetos criados durante a recuperacao de um 500.
          metadata: {
            paymentId: input.reference.paymentId,
            orderId: input.reference.orderId,
            attemptCount: String(input.reference.attemptCount),
          },
        },
        // Idempotencia DO PROVEDOR, com a NOSSA chave derivada
        // (paymentId:attemptCount). Deixar o SDK gerar a dele tornaria o replay
        // impossivel de reproduzir do nosso lado.
        { idempotencyKey: input.idempotencyKey },
      );

      return resultadoDaCriacao(intent);
    } catch (erro) {
      // Recusa NAO e excecao no nosso contrato. A Stripe devolve card_error
      // (402) com o payment_intent no corpo, e e dele que sai o providerRef.
      if (erro instanceof Stripe.errors.StripeCardError) {
        const ref = erro.payment_intent?.id;
        if (ref === undefined) {
          // Sem referencia nao ha como registrar a tentativa; e conteudo
          // inesperado, nao recusa utilizavel.
          throw new ProviderInvalidRequestError('card_error sem payment_intent');
        }
        return recusaDeCobranca(ref, {
          code: erro.code,
          decline_code: erro.decline_code,
          message: erro.message,
        });
      }
      lancarTraduzido(erro, 'criar');
    }
  }

  async getCharge(_providerRef: ProviderRef): Promise<ChargeSnapshot> {
    throw new Error(PENDENTE_NO_9B2);
  }

  async buscarCobrancaPorTentativa(
    _paymentId: string,
    _attemptCount: number,
  ): Promise<ChargeSnapshot | null> {
    throw new Error(PENDENTE_NO_9B2);
  }

  async cancelCharge(_input: CancelChargeInput): Promise<ChargeSnapshot> {
    throw new Error(PENDENTE_NO_9B2);
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    throw new Error(PENDENTE_NO_9B2);
  }

  verifyWebhook(_request: WebhookRequest): WebhookEventPayload {
    throw new Error(PENDENTE_NO_9B2);
  }
}
