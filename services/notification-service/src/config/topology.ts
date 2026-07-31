// Contrato de mensageria (lado consumidor). EXCHANGE deve casar com o produtor
// (order-service). QUEUE e BINDING sao DESTE servico — ele e o dono da fila.
export const EXCHANGE = 'orders';
export const EXCHANGE_TYPE = 'topic';
export const QUEUE = 'notifications.orders';
export const BINDING_KEY = 'order.*';

// Dead-letter: mensagem envenenada (nack sem requeue) vai para a DLQ.
export const DLX = 'notifications.dlx';
export const DLQ = 'notifications.orders.dlq';
