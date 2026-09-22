import { mesmoFato } from '../../../src/events/outbox.repository';

const base = {
  routingKey: 'payment.captured',
  payload: { paymentId: 'pay_1', orderId: 'ord_1', amountCents: 1000, currency: 'BRL', occurredAt: '2026-09-22T10:00:00.000Z' },
};

describe('mesmoFato — o que conta como duplicata do mesmo evento', () => {
  it('O-U1: occurredAt diferente continua sendo o MESMO fato', () => {
    const depois = { ...base, payload: { ...base.payload, occurredAt: '2026-09-22T10:05:00.000Z' } };
    expect(mesmoFato(base, depois)).toBe(true);
  });

  it('O-U2: a ordem das chaves nao importa (o jsonb reordena ao gravar)', () => {
    const reordenado = {
      routingKey: 'payment.captured',
      payload: { occurredAt: 'x', currency: 'BRL', amountCents: 1000, orderId: 'ord_1', paymentId: 'pay_1' },
    };
    expect(mesmoFato(base, reordenado)).toBe(true);
  });

  it('O-U3: um campo de NEGOCIO diferente e outro fato', () => {
    expect(mesmoFato(base, { ...base, payload: { ...base.payload, amountCents: 999 } })).toBe(false);
  });

  it('O-U4: routing key diferente e outro fato, mesmo com payload igual', () => {
    expect(mesmoFato(base, { ...base, routingKey: 'payment.expired' })).toBe(false);
  });

  it('O-U5: campo a mais ou a menos e outro fato', () => {
    const { currency: _c, ...semMoeda } = base.payload;
    expect(mesmoFato(base, { ...base, payload: semMoeda })).toBe(false);
  });
});
