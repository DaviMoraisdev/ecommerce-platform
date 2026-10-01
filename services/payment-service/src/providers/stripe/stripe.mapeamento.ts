import type { ChargeResult } from '../payment-provider.port';

/**
 * A variante DECLINED da uniao, extraida em vez de redeclarada: se a porta
 * mudar os campos da recusa, isto acompanha e o compilador cobra aqui.
 */
export type RecusaDeCobranca = Extract<ChargeResult, { state: 'DECLINED' }>;

/**
 * Traducao PURA: Stripe -> nosso dominio. Sem I/O, sem SDK instanciado.
 *
 * Erro de mapeamento e o defeito mais provavel desta integracao e o mais caro
 * (dinheiro registrado como estado errado). Mantendo a traducao pura, ela e
 * provada por tabela, sem rede e sem duble.
 */

/**
 * SO os campos que LEMOS do PaymentIntent, e nao o tipo inteiro do SDK.
 *
 * Mesma politica do inbox do Bloco 4: dado desconhecido do provedor nao
 * atravessa a fronteira. O objeto do SDK e ATRIBUIVEL a esta interface, e o
 * `tsc` verifica isso no ponto de chamada e no teste de tipo — se a Stripe
 * renomear um campo que lemos, a compilacao quebra.
 */
export interface IntentLido {
  id: string;
  status: string;
  amount: number;
  amount_received: number;
  last_payment_error?: ErroDeCobrancaLido | null;
}

/** Campos que lemos de um card_error (402) ou de last_payment_error. */
export interface ErroDeCobrancaLido {
  code?: string | null;
  decline_code?: string | null;
  message?: string | null;
}

/**
 * Status que a Stripe pode devolver e que NAO sabemos traduzir.
 *
 * Lancar e deliberado: `requires_confirmation` apos `confirm: true`, ou um
 * status novo que a Stripe introduza, significa que a premissa do adaptador
 * deixou de valer. Escolher um estado nosso "parecido" gravaria estado
 * financeiro inventado.
 */
export class EstadoInesperadoDoIntentError extends Error {
  constructor(
    readonly intentId: string,
    readonly status: string,
  ) {
    super(`PaymentIntent ${intentId} em estado inesperado para criacao: ${status}`);
    this.name = 'EstadoInesperadoDoIntentError';
  }
}

/** Nao existe recusa sem codigo no nosso contrato; a Stripe admite ausencia. */
export const RECUSA_SEM_CODIGO = 'unknown_decline';

/** Cancelamento nao e estado de ChargeResult; vira recusa com codigo proprio. */
export const RECUSA_POR_CANCELAMENTO = 'payment_intent_canceled';

export function resultadoDaCriacao(intent: IntentLido): ChargeResult {
  switch (intent.status) {
    case 'succeeded':
      // amount_received, NAO amount: capturado e o que entrou, nao o pedido.
      return {
        providerRef: intent.id,
        state: 'SUCCEEDED',
        capturedAmountCents: intent.amount_received,
      };

    case 'processing':
    case 'requires_action':
    case 'requires_capture':
      // Nada capturado ainda. requires_capture so aparece com captura manual,
      // que nao usamos — mapeado por defesa, nao por uso.
      return { providerRef: intent.id, state: 'PROCESSING', capturedAmountCents: 0 };

    case 'canceled':
      return {
        providerRef: intent.id,
        state: 'DECLINED',
        capturedAmountCents: 0,
        declineCode: RECUSA_POR_CANCELAMENTO,
      };

    case 'requires_payment_method':
      // O STATUS e ambiguo: vale para intent recem-criado E para tentativa
      // recusada. O que desambigua e last_payment_error. Sem ele, confirmamos
      // com token e o intent voltou sem erro: premissa violada.
      if (intent.last_payment_error === null || intent.last_payment_error === undefined) {
        throw new EstadoInesperadoDoIntentError(intent.id, intent.status);
      }
      return recusaDeCobranca(intent.id, intent.last_payment_error);

    default:
      throw new EstadoInesperadoDoIntentError(intent.id, intent.status);
  }
}

/**
 * Recusa vinda do card_error (402). O contrato da porta exige declineCode
 * SEMPRE, e a Stripe admite `decline_code` e `code` nulos — por isso o fallback
 * explicito em vez de `as string`.
 *
 * Precedencia: decline_code (motivo do EMISSOR) antes de code (classificacao da
 * Stripe). O do emissor e o que explica a recusa para o operador.
 */
export function recusaDeCobranca(providerRef: string, erro: ErroDeCobrancaLido): RecusaDeCobranca {
  const codigo = texto(erro.decline_code) ?? texto(erro.code) ?? RECUSA_SEM_CODIGO;
  const mensagem = texto(erro.message);
  return {
    providerRef,
    state: 'DECLINED',
    capturedAmountCents: 0,
    declineCode: codigo,
    ...(mensagem === undefined ? {} : { declineMessage: mensagem }),
  };
}

/** String vazia e string de espacos sao ausencia, nao valor. */
function texto(valor: string | null | undefined): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const limpo = valor.trim();
  return limpo === '' ? undefined : limpo;
}
