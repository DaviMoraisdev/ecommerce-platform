import Stripe from 'stripe';

import {
  ProviderInvalidRequestError,
  ProviderUnavailableError,
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
import { CODIGO_ESTADO_INESPERADO, lancarTraduzido } from './stripe.erros';
import {
  recusaDeCobranca,
  resultadoDaCriacao,
  resultadoDoReembolso,
  snapshotDaCobranca,
} from './stripe.mapeamento';

export interface StripeProviderDeps {
  secretKey: string;
  webhookSecret: string;
  /** Injetavel para o teste do teto nao precisar de dez respostas. */
  tetoDePaginas?: number;
  /**
   * `fetch` injetavel, usado via Stripe.createFetchHttpClient(fetchFn).
   * Existe para o TESTE provar o FORMATO DA REQUISICAO sem tocar a rede: o
   * mapeamento da resposta ja esta provado no 9b-1, e o que ninguem tinha
   * verificado e o que sai daqui.
   */
  fetchFn?: typeof fetch;
}

/**
 * Janela de busca por correlacao, em horas.
 *
 * ESTREITA DE PROPOSITO. A Stripe nao filtra metadado em list (so na Search
 * API, descartada no 9b-1 por atraso de propagacao), entao a correlacao e
 * filtrada LOCALMENTE sobre uma janela de `created`. Se a cobranca for mais
 * antiga que a janela, o resultado e `null` — e com ausenciaEDefinitiva false
 * isso vira TRIAGEM, nunca liberacao. O pior caso e um pagamento preso e
 * visivel, que e o estado seguro do 6b e do 6e. Janela larga custaria chamadas
 * e rate limit sem comprar seguranca.
 */
export const JANELA_DE_BUSCA_HORAS = 24;
export const TAMANHO_DA_PAGINA = 100;
export const TETO_DE_PAGINAS = 10;

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

  async getCharge(providerRef: ProviderRef): Promise<ChargeSnapshot> {
    try {
      return snapshotDaCobranca(await this.lerIntent(providerRef));
    } catch (erro) {
      lancarTraduzido(erro, 'consultar');
    }
  }

  /**
   * O `expand` NAO e opcional aqui: o valor reembolsado vive no Charge, e sem
   * ele o snapshot recebe latest_charge como STRING e lanca (9b-1). Centralizado
   * num metodo porque TODO caminho que monta snapshot precisa dele — cancel
   * incluido.
   */
  private async lerIntent(providerRef: ProviderRef): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.retrieve(providerRef, { expand: ['latest_charge'] });
  }

  async buscarCobrancaPorTentativa(
    paymentId: string,
    attemptCount: number,
  ): Promise<ChargeSnapshot | null> {
    const desde = Math.floor(Date.now() / 1000) - JANELA_DE_BUSCA_HORAS * 60 * 60;
    const teto = this.deps.tetoDePaginas ?? TETO_DE_PAGINAS;
    let cursor: string | undefined;

    try {
      for (let pagina = 0; pagina < teto; pagina += 1) {
        const lista = await this.stripe.paymentIntents.list({
          created: { gte: desde },
          limit: TAMANHO_DA_PAGINA,
          // Cada item precisa do Charge: sem isso o snapshot lanca.
          expand: ['data.latest_charge'],
          ...(cursor === undefined ? {} : { starting_after: cursor }),
        });

        const achado = lista.data.find((intent) =>
          this.ehDaTentativa(intent, paymentId, attemptCount),
        );
        if (achado !== undefined) return snapshotDaCobranca(achado);

        const ultimo = lista.data[lista.data.length - 1];
        if (!lista.has_more || ultimo === undefined) return null;
        cursor = ultimo.id;
      }
    } catch (erro) {
      lancarTraduzido(erro, 'consultar');
    }

    // TETO ALCANCADO sem achar. Isto NAO e ausencia: `null` afirmaria "nao
    // existe", e o que temos e "nao terminei de olhar". Falha tecnica mantem a
    // tentativa presa e visivel — mesmo padrao do job do 6e.
    throw new ProviderUnavailableError(
      `busca por correlacao excedeu ${teto} paginas sem concluir (paymentId ${paymentId}, tentativa ${attemptCount})`,
    );
  }

  /**
   * A correlacao e a que o createCharge gravou em metadata. attemptCount e
   * comparado como STRING porque metadata da Stripe guarda texto.
   */
  private ehDaTentativa(
    intent: Stripe.PaymentIntent,
    paymentId: string,
    attemptCount: number,
  ): boolean {
    return (
      intent.metadata?.paymentId === paymentId &&
      intent.metadata?.attemptCount === String(attemptCount)
    );
  }

  async cancelCharge(input: CancelChargeInput): Promise<ChargeSnapshot> {
    try {
      const intent = await this.stripe.paymentIntents.cancel(
        input.providerRef,
        { expand: ['latest_charge'] },
        { idempotencyKey: input.idempotencyKey },
      );
      return snapshotDaCobranca(intent);
    } catch (erro) {
      // A Stripe devolve payment_intent_unexpected_state em DOIS casos opostos:
      // ja cancelado e ja capturado. O contrato exige no-op no primeiro e
      // ChargeNotCancelableError no segundo, e o codigo nao distingue — so o
      // ESTADO distingue. Por isso a leitura extra, apenas no caminho de erro.
      if (
        erro instanceof Stripe.errors.StripeInvalidRequestError &&
        erro.code === CODIGO_ESTADO_INESPERADO
      ) {
        const atual = await this.lerIntent(input.providerRef);
        if (atual.status === 'canceled') {
          // Idempotencia por ESTADO: cancelar o que ja esta cancelado e no-op,
          // mesmo com chave nova.
          return snapshotDaCobranca(atual);
        }
        // Capturado (ou qualquer outro estado que recusa cancelamento): a
        // traducao devolve ChargeNotCancelableError, que o job do 6e le como
        // "ja capturou" — informacao, nao falha.
      }
      lancarTraduzido(erro, 'cancelar');
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    try {
      const reembolso = await this.stripe.refunds.create(
        // payment_intent, e nao charge: reembolsar o PaymentIntent e
        // equivalente a reembolsar a cobranca por tras dele, e e o id que nos
        // guardamos como providerRef.
        { payment_intent: input.providerRef, amount: input.amountCents },
        { idempotencyKey: input.idempotencyKey },
      );
      return resultadoDoReembolso(reembolso);
    } catch (erro) {
      lancarTraduzido(erro, 'reembolsar');
    }
  }

  verifyWebhook(_request: WebhookRequest): WebhookEventPayload {
    throw new Error(PENDENTE_NO_9B2);
  }
}
