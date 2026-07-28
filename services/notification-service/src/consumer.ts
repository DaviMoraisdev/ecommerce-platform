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
  orderId: string;
  userId?: string;
  status?: string;
  total?: number;
  at?: string;
}

// Guard de runtime: JSON garante so a sintaxe. Validamos o contrato: obrigatorios
// (type, orderId) e, se presentes, o TIPO de cada opcional (schema incorreto = rejeita).
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

  if (o.userId !== undefined && typeof o.userId !== 'string') return null;
  if (o.status !== undefined && typeof o.status !== 'string') return null;
  if (o.at !== undefined && typeof o.at !== 'string') return null;
  if (o.total !== undefined && (typeof o.total !== 'number' || !Number.isFinite(o.total))) {
    return null;
  }

  return {
    type,
    orderId,
    userId: o.userId as string | undefined,
    status: o.status as string | undefined,
    total: o.total as number | undefined,
    at: o.at as string | undefined,
  };
}

// "Envia" a notificacao. No 8a e um stub que loga; e-mail/push ficam para depois.
export function handleEvent(event: OrderEvent): void {
  switch (event.type) {
    case 'order.created':
      console.log(
        '[notificacao] pedido ' + event.orderId + ' criado' +
          (event.userId ? ' (usuario ' + event.userId + ')' : '') +
          (event.total !== undefined ? ' total ' + event.total : '')
      );
      break;
    case 'order.status_changed':
      console.log(
        '[notificacao] pedido ' + event.orderId + ' mudou para ' + (event.status ?? '?')
      );
      break;
    default:
      console.log('[notificacao] evento nao tratado: ' + sanitizeForLog(event.type));
  }
}
