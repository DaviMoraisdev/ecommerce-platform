/**
 * Contrato de mensageria do payment-service (lado produtor).
 *
 * Exchange PROPRIO, e nao o `orders` do order-service. Cada servico e dono do
 * exchange que ele publica; o consumidor e dono da fila e do binding — e o que o
 * topology.ts do notification-service documenta. Publicar evento de pagamento num
 * exchange chamado `orders` faria o nome mentir sobre o que trafega nele.
 *
 * O nome do exchange e as routing keys sao o CONTRATO com quem consome. Quando o
 * Bloco 5b criar a fila no order-service, os dois lados precisam ficar em
 * sincronia (duplicacao ja registrada no TECH_DEBT, Fase 10).
 */
export const EXCHANGE = 'payments';
export const EXCHANGE_TYPE = 'topic';

/**
 * Unico evento publicado no Bloco 5a.
 *
 * `payment.failed` NAO entra: a janela de retentativa continua aberta (decisao 5
 * da fase) e o pedido nao deve mudar de estado. `payment.canceled` provavelmente
 * vira pedido CANCELADO, mas isso e decisao de negocio que pertence ao 5b, junto
 * do consumidor. Publicar evento sem consumidor definido e ruido na fila.
 */
export const ROUTING_PAYMENT_CAPTURED = 'payment.captured';

/**
 * `eventId` DETERMINISTICO, derivado do pagamento.
 *
 * `OutboxEvent.eventId` e @unique. Com id derivado, uma segunda tentativa de
 * gravar o mesmo evento COLIDE no banco em vez de criar duplicata — idempotencia
 * por construcao. Um uuid aleatorio transformaria erro de logica em evento
 * duplicado silencioso. CAPTURED e terminal, entao ha no maximo um por pagamento.
 */
export function eventIdDeCaptura(paymentId: string): string {
  return ROUTING_PAYMENT_CAPTURED + ':' + paymentId;
}

/**
 * Bloco 6f. Publicado pelo job de EXPIRACAO da janela (Bloco 6e), no mesmo
 * commit da transicao para `Payment.EXPIRED`.
 *
 * O 6e entregou a expiracao DESLIGADA justamente porque este evento nao
 * existia: cada pagamento expirado viraria registro sem evento de outbox, e um
 * produtor acrescentado depois so cobre transicoes NOVAS. Publicar sem o
 * binding do lado consumidor tambem nao servia — o publisher usa `mandatory` +
 * `basic.return`, entao a mensagem voltaria como nao roteavel. Por isso os dois
 * lados entram juntos.
 */
export const ROUTING_PAYMENT_EXPIRED = 'payment.expired';

/**
 * Mesma construcao do `eventIdDeCaptura`, e pela mesma razao: `OutboxEvent`
 * tem `eventId` @unique, entao id DERIVADO faz a segunda gravacao COLIDIR em
 * vez de duplicar. EXPIRED e terminal, logo ha no maximo um por pagamento.
 */
export function eventIdDeExpiracao(paymentId: string): string {
  return ROUTING_PAYMENT_EXPIRED + ':' + paymentId;
}
