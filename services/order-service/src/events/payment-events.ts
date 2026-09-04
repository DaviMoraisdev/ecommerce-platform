// Contrato dos eventos de pagamento, do lado de quem recebe.
// Espelha PayloadDeCaptura do payment-service (TECH_DEBT: duplicacao, Fase 10).
// NOTA: o payload NAO tem campo "type" — o notification cruza type x routingKey,
// aqui essa defesa nao existe e o binding estrito faz o papel dela.
export interface CapturaEvent {
  eventId: string;
  paymentId: string;
  orderId: string;
  amountCents: number;
  capturedAmountCents: number;
  currency: string;
  occurredAt?: string;
}

const MAX_ID = 200;

function idValido(v: unknown, max = MAX_ID): v is string {
  // trim() !== v recusa " abc": id canonico, senao a MESMA entidade teria duas
  // representacoes e o @unique do inbox deixaria as duas passarem.
  return typeof v === 'string' && v.trim() !== '' && v.trim() === v && v.length <= max;
}

// Teto = limite da coluna. amountCents e INTEGER no Postgres (Int no Prisma),
// que vai ate 2_147_483_647. O teto anterior era 1 bilhao de REAIS em centavos,
// quase 47x acima disso: o valor passava na entrada e estourava no insert,
// depois de a transacao ja estar aberta. Limite de entrada tem de ser o limite
// do que se consegue PERSISTIR, nao um numero redondo escolhido a parte.
const MAX_CENTAVOS = 2_147_483_647;

function centavosValidos(v: unknown): v is number {
  // isSafeInteger, nao isInteger: acima de 2^53 a aritmetica de ponto flutuante
  // perde precisao em silencio, e 2**53 e 2**53+1 viram o mesmo numero.
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTAVOS;
}

// O eventId e a chave de idempotencia. Se ele nao estiver amarrado ao
// identificador financeiro, o MESMO pagamento reentregue com outro eventId
// atravessa a trava, e um eventId reaproveitado faz um pagamento legitimo ser
// descartado como duplicata. Aqui a relacao deixa de ser convencao e vira
// verificacao.
export function eventIdEsperado(paymentId: string): string {
  return 'payment.captured:' + paymentId;
}

// Devolve null em vez de lancar: quem chama traduz isso em DLQ, e "invalido"
// nao e situacao excepcional aqui — e uma das saidas esperadas.
/**
 * Campos comuns aos dois eventos, validados UMA vez.
 *
 * Extraido no Bloco 6f, no segundo uso. O criterio e o mesmo do keyset no
 * payment-service: o COMPILADOR nao pega divergencia entre dois validadores —
 * um passa a aceitar o que o outro recusa, e a diferenca so aparece quando uma
 * mensagem hostil escolhe o caminho mais frouxo.
 */
interface CamposComuns {
  eventId: string;
  paymentId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  occurredAt?: string;
}

function validarComuns(
  o: Record<string, unknown>,
  esperado: (paymentId: string) => string,
): CamposComuns | null {
  if (!idValido(o.eventId)) return null;
  if (!idValido(o.paymentId)) return null;
  if (!idValido(o.orderId)) return null;
  if (!centavosValidos(o.amountCents)) return null;
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) return null;
  if (o.eventId !== esperado(o.paymentId)) return null;
  if (o.occurredAt !== undefined && typeof o.occurredAt !== 'string') return null;

  return {
    eventId: o.eventId,
    paymentId: o.paymentId,
    orderId: o.orderId,
    amountCents: o.amountCents,
    currency: o.currency,
    occurredAt: o.occurredAt as string | undefined,
  };
}

/** Objeto JSON, ou null. Recusa array e primitivo antes de qualquer campo. */
function comoObjeto(raw: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}


export function parseCaptura(raw: string): CapturaEvent | null {
  const o = comoObjeto(raw);
  if (o === null) return null;

  const comuns = validarComuns(o, eventIdEsperado);
  if (comuns === null) return null;

  if (!centavosValidos(o.capturedAmountCents)) return null;

  return { ...comuns, capturedAmountCents: o.capturedAmountCents };
}

/**
 * Contrato do evento payment.expired (Bloco 6f).
 *
 * NAO tem `capturedAmountCents`, porque nada foi capturado. O `amountCents`
 * continua vindo para que o consumidor possa conferir contra o total do pedido
 * antes de cancelar — cancelar pedido a partir de um evento cujo valor nao bate
 * seria agir sobre o pedido errado.
 */
export interface ExpiracaoEvent extends CamposComuns {}

export function eventIdEsperadoDeExpiracao(paymentId: string): string {
  return 'payment.expired:' + paymentId;
}

export function parseExpiracao(raw: string): ExpiracaoEvent | null {
  const o = comoObjeto(raw);
  if (o === null) return null;

  return validarComuns(o, eventIdEsperadoDeExpiracao);
}
