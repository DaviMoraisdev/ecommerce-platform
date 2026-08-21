import { PaymentStatus, type Payment } from '@prisma/client';
import { montarEventoDeCaptura } from '../../../src/events/payment.events';

const AGORA = new Date('2026-08-20T12:00:00.000Z');

function pagamento(): Payment {
  return {
    id: 'pay_1',
    orderId: 'ord_1',
    userId: 'usr_1',
    status: PaymentStatus.CAPTURED,
    amountCents: 12990,
    capturedAmountCents: 12990,
    refundedAmountCents: 0,
    currency: 'BRL',
    provider: 'fake',
    attemptCount: 1,
    expiresAt: AGORA,
    createdAt: AGORA,
    updatedAt: AGORA,
  } as Payment;
}

describe('montarEventoDeCaptura — contrato do que sai na fila', () => {
  it('CASO A4: payload tem SO os campos do contrato, e nada do provedor', async () => {
    const ev = montarEventoDeCaptura(pagamento(), AGORA);

    expect(ev.routingKey).toBe('payment.captured');
    expect(ev.eventId).toBe('payment.captured:pay_1');

    const payload = ev.payload as Record<string, unknown>;
    // Lista FECHADA e ordenada: campo novo no evento nao entra sem alguem
    // decidir. O evento atravessa a rede e fica parado numa fila.
    expect(Object.keys(payload).sort()).toEqual([
      'amountCents',
      'capturedAmountCents',
      'currency',
      'eventId',
      'occurredAt',
      'orderId',
      'paymentId',
    ]);
    expect(payload.paymentId).toBe('pay_1');
    expect(payload.orderId).toBe('ord_1');
    expect(payload.capturedAmountCents).toBe(12990);
    expect(payload.occurredAt).toBe(AGORA.toISOString());
  });
});
