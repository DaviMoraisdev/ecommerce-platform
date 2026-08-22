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

function centavosValidos(v: unknown): v is number {
  // Integer, nao float: dinheiro em centavos. 100.5 centavos e contrato quebrado,
  // e Number.isInteger tambem barra NaN e Infinity.
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
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
