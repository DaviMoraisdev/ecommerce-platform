// Contrato do evento payment.captured, do lado de quem recebe.
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

// Teto explicito: 1 bilhao de reais em centavos. Valor monetario acima disso
// neste sistema e erro, nao negocio.
const MAX_CENTAVOS = 100_000_000_000;

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
export function parseCaptura(raw: string): CapturaEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;

  if (!idValido(o.eventId)) return null;
  if (!idValido(o.paymentId)) return null;
  if (!idValido(o.orderId)) return null;
  if (!centavosValidos(o.amountCents)) return null;
  if (!centavosValidos(o.capturedAmountCents)) return null;
  if (typeof o.currency !== 'string' || o.currency.trim() === '') return null;
  if (o.eventId !== eventIdEsperado(o.paymentId)) return null;
  if (o.occurredAt !== undefined && typeof o.occurredAt !== 'string') return null;

  return {
    eventId: o.eventId,
    paymentId: o.paymentId,
    orderId: o.orderId,
    amountCents: o.amountCents,
    capturedAmountCents: o.capturedAmountCents,
    currency: o.currency,
    occurredAt: o.occurredAt as string | undefined,
  };
}
