// Topologia compartilhada entre publisher e consumer — fonte unica de verdade
// para nomes de exchange/fila/binding, evitando divergencia entre os dois lados.
export const EXCHANGE = 'orders';
export const EXCHANGE_TYPE = 'topic';
export const QUEUE = 'orders.demo';
export const BINDING_KEY = 'order.*';
