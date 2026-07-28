// Remove caracteres de controle (evita injecao em terminal/log) e trunca.
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
  eventId?: string;
  orderId: string;
  userId?: string;
  status?: string;
  total?: number;
  at?: string;
}

// Valida o contrato em runtime. Alem dos obrigatorios comuns (type, orderId),
// cada tipo exige campos proprios: order.created -> total; order.status_changed
// -> status. Campo presente com tipo errado = schema incorreto -> rejeita.
export function parseEvent(raw: string): OrderEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null;
  }
  const o = v as Record<string, unknown>;

  const type = o.type;
  const orderId = o.orderId;
  if (typeof type !== 'string' || type.trim() === '') return null;
  if (typeof orderId !== 'string' || orderId.trim() === '') return null;

  if (o.eventId !== undefined && typeof o.eventId !== 'string') return null;
  if (o.userId !== undefined && typeof o.userId !== 'string') return null;
  if (o.status !== undefined && typeof o.status !== 'string') return null;
  if (o.at !== undefined && typeof o.at !== 'string') return null;
  if (o.total !== undefined && (typeof o.total !== 'number' || !Number.isFinite(o.total))) {
    return null;
  }

  // Obrigatorios por tipo:
  if (type === 'order.status_changed' && (typeof o.status !== 'string' || o.status.trim() === '')) {
    return null;
  }
  if (type === 'order.created' && (typeof o.total !== 'number' || !Number.isFinite(o.total))) {
    return null;
  }

  return {
    type,
    eventId: o.eventId as string | undefined,
    orderId,
    userId: o.userId as string | undefined,
    status: o.status as string | undefined,
    total: o.total as number | undefined,
    at: o.at as string | undefined,
  };
}

// Decide ack/nack de uma mensagem crua. Pura e testavel (sem canal real):
// payload invalido/incompleto ou routing key incompativel com o type -> nack.
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

// "Envia" a notificacao (stub que loga). Sanitiza TODO campo derivado do evento
// antes de interpolar (anti log-injection); total ja e number validado.
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
        '[notificacao] pedido ' + orderId + ' mudou para ' +
          (event.status ? sanitizeForLog(event.status) : '?')
      );
      break;
    default:
      console.log('[notificacao] evento nao tratado: ' + sanitizeForLog(event.type));
  }
}
