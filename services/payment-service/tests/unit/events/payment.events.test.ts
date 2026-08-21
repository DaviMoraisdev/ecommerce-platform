import { montarEventoDeCaptura, type CapturaConfirmada } from '../../../src/events/payment.events';

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
