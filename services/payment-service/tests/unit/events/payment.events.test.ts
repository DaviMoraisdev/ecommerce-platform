import { montarEventoDeCaptura,
  montarEventoDeExpiracao, type CapturaConfirmada } from '../../../src/events/payment.events';

const AGORA = new Date('2026-08-20T12:00:00.000Z');

function captura(overrides: Partial<CapturaConfirmada> = {}): CapturaConfirmada {
  return {
    paymentId: 'pay_1',
    orderId: 'ord_1',
    amountCents: 12990,
    capturedAmountCents: 12990,
    currency: 'BRL',
    ...overrides,
  };
}

describe('montarEventoDeCaptura — contrato do que sai na fila', () => {
  it('CASO A4: payload tem SO os campos do contrato, e nada do provedor', () => {
    const ev = montarEventoDeCaptura(captura(), AGORA);

    expect(ev.routingKey).toBe('payment.captured');
    expect(ev.eventId).toBe('payment.captured:pay_1');

    const payload = ev.payload as unknown as Record<string, unknown>;
    // Lista FECHADA: campo novo no evento nao entra sem alguem decidir.
    expect(Object.keys(payload).sort()).toEqual([
      'amountCents',
      'capturedAmountCents',
      'currency',
      'eventId',
      'occurredAt',
      'orderId',
      'paymentId',
    ]);
    expect(payload.occurredAt).toBe(AGORA.toISOString());
  });

  it('CASO A5: usa o valor CONFIRMADO da captura, nao o cobrado', () => {
    // Captura parcial: se o evento saisse com amountCents no lugar do
    // capturedAmountCents, o pedido seria marcado pago por um valor que nao
    // entrou. O tipo exige os dois separados justamente por isso.
    const ev = montarEventoDeCaptura(captura({ capturedAmountCents: 5000 }), AGORA);
    const payload = ev.payload as unknown as Record<string, unknown>;

    expect(payload.capturedAmountCents).toBe(5000);
    expect(payload.amountCents).toBe(12990);
  });
});


describe('montarEventoDeExpiracao (Bloco 6f)', () => {
  const base = {
    paymentId: 'pay_1',
    orderId: 'ord_1',
    amountCents: 12990,
    currency: 'BRL',
  };

  it('CASO P1: eventId DERIVADO do pagamento, com a routing key propria', () => {
    // Id derivado e o que torna a gravacao idempotente: a segunda tentativa
    // colide no @unique da outbox em vez de criar duplicata.
    const evento = montarEventoDeExpiracao(base, new Date('2026-09-04T10:00:00Z'));

    expect(evento.eventId).toBe('payment.expired:pay_1');
    expect(evento.routingKey).toBe('payment.expired');
  });

  it('CASO P2: payload FECHADO, sem campo de captura', () => {
    // O contrato do que atravessa a rede e minimo de proposito. Nao ha
    // capturedAmountCents porque nada foi capturado — campo que so pode valer
    // zero e ruido que o consumidor teria de interpretar.
    const evento = montarEventoDeExpiracao(base, new Date('2026-09-04T10:00:00Z'));
    const payload = evento.payload as unknown as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      'amountCents',
      'currency',
      'eventId',
      'occurredAt',
      'orderId',
      'paymentId',
    ]);
    expect(payload.occurredAt).toBe('2026-09-04T10:00:00.000Z');
  });
});
