export function sanitizeForLog(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? '?' : ch;
  }
  return out.length > 300 ? out.slice(0, 300) + '...' : out;
}

export interface OrderEvent {
  type: string;
  eventId: string;
  orderId: string;
  userId?: string;
  status?: string;
  total?: number;
  at?: string;
}

// Valida o contrato em runtime. eventId: obrigatorio, canonico (sem espacos
// perifericos) e com cap de tamanho (vira chave no Redis).
export function parseEvent(raw: string): OrderEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;

  const type = o.type;
  const orderId = o.orderId;
  if (typeof type !== 'string' || type.trim() === '') return null;
  if (typeof orderId !== 'string' || orderId.trim() === '') return null;
  if (
    typeof o.eventId !== 'string' ||
    o.eventId.trim() === '' ||
    o.eventId.trim() !== o.eventId ||
    o.eventId.length > 128
  ) {
    return null;
  }
  if (o.userId !== undefined && typeof o.userId !== 'string') return null;
  if (o.status !== undefined && typeof o.status !== 'string') return null;
  if (o.at !== undefined && typeof o.at !== 'string') return null;
  if (o.total !== undefined && (typeof o.total !== 'number' || !Number.isFinite(o.total))) {
    return null;
  }
  if (type === 'order.status_changed' && (typeof o.status !== 'string' || o.status.trim() === '')) {
    return null;
  }
  if (type === 'order.created' && (typeof o.total !== 'number' || !Number.isFinite(o.total))) {
    return null;
  }

  return {
    type,
    eventId: o.eventId as string,
    orderId,
    userId: o.userId as string | undefined,
    status: o.status as string | undefined,
    total: o.total as number | undefined,
    at: o.at as string | undefined,
  };
}

export function decideMessage(
  raw: string,
  routingKey: string
): { ack: boolean; event: OrderEvent | null; reason?: string } {
  const event = parseEvent(raw);
  if (!event) {
    return { ack: false, event: null, reason: 'payload invalido ou incompleto' };
  }
  if (event.type !== routingKey) {
    return {
      ack: false,
      event: null,
      reason: 'routing key (' + sanitizeForLog(routingKey) + ') != type (' + sanitizeForLog(event.type) + ')',
    };
  }
  return { ack: true, event };
}

export function handleEvent(event: OrderEvent): void {
  const orderId = sanitizeForLog(event.orderId);
  switch (event.type) {
    case 'order.created':
      console.log(
        '[notificacao] pedido ' + orderId + ' criado' +
          (event.userId ? ' (usuario ' + sanitizeForLog(event.userId) + ')' : '') +
          (event.total !== undefined ? ' total ' + event.total : '')
      );
      break;
    case 'order.status_changed':
      console.log(
        '[notificacao] pedido ' + orderId + ' mudou para ' + (event.status ? sanitizeForLog(event.status) : '?')
      );
      break;
    default:
      console.log('[notificacao] evento nao tratado: ' + sanitizeForLog(event.type));
  }
}

export type DeliveryAction =
  | { type: 'ack'; reason: 'processed' | 'duplicate' }
  | { type: 'nack-dlq'; reason: string }
  | { type: 'nack-requeue'; reason: string };

export interface DeliveryDeps {
  claim: (eventId: string) => Promise<string | null>;
  release: (eventId: string, token: string) => Promise<boolean>;
  handle: (event: OrderEvent) => void;
  recordProcessed?: (event: OrderEvent) => Promise<void>;
}

// Fases separadas. Ponto critico: se o processamento falha APOS o claim, tenta
// LIBERAR; se conseguir -> requeue (reprocessa); se NAO conseguir liberar, NAO
// faz requeue (viraria duplicata-ack = perda) e sim manda pra DLQ (preservado).
export async function handleDelivery(
  raw: string,
  routingKey: string,
  deps: DeliveryDeps
): Promise<DeliveryAction> {
  const decision = decideMessage(raw, routingKey);
  if (!decision.ack || !decision.event) {
    return { type: 'nack-dlq', reason: decision.reason ?? 'invalido' };
  }
  const event = decision.event;

  let token: string | null;
  try {
    token = await deps.claim(event.eventId);
  } catch (err) {
    return { type: 'nack-requeue', reason: 'store indisponivel: ' + (err instanceof Error ? err.message : String(err)) };
  }
  if (token === null) {
    return { type: 'ack', reason: 'duplicate' };
  }

  try {
    deps.handle(event);
    if (deps.recordProcessed) {
      try {
        await deps.recordProcessed(event);
      } catch {
        /* marcador best-effort: nao falha o ack */
      }
    }
    return { type: 'ack', reason: 'processed' };
  } catch (handleErr) {
    const reason = handleErr instanceof Error ? handleErr.message : String(handleErr);
    let released = false;
    try {
      released = await deps.release(event.eventId, token);
    } catch {
      released = false;
    }
    if (released) {
      return { type: 'nack-requeue', reason: 'processamento falhou, claim liberado: ' + reason };
    }
    return { type: 'nack-dlq', reason: 'processamento falhou e claim NAO liberado (evitando perda): ' + reason };
  }
}

export interface ChannelLike {
  ack(msg: unknown): void;
  nack(msg: unknown, allUpTo: boolean, requeue: boolean): void;
}

// Traduz a acao em ack/nack no canal. nack-requeue passa por um atraso (anti hot loop).
export async function executeAction(
  ch: ChannelLike,
  msg: unknown,
  action: DeliveryAction,
  onRequeueDelay: () => Promise<void>
): Promise<void> {
  if (action.type === 'ack') {
    ch.ack(msg);
    return;
  }
  if (action.type === 'nack-dlq') {
    ch.nack(msg, false, false);
    return;
  }
  await onRequeueDelay();
  ch.nack(msg, false, true);
}
