// Contrato de mensageria do order-service (lado produtor).
// O nome do exchange e as routing keys sao o CONTRATO com o notification-service.
// Estao duplicados la (pacotes npm separados) — manter os dois lados em sincronia.
export const EXCHANGE = 'orders';
export const EXCHANGE_TYPE = 'topic';

export const ROUTING_ORDER_CREATED = 'order.created';
export const ROUTING_ORDER_STATUS_CHANGED = 'order.status_changed';
