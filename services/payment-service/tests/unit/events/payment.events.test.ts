import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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


describe('contrato payment.expired (lado produtor)', () => {
  it('CASO K3: o produtor GERA exatamente o payload publicado', () => {
    // A fixture e a MESMA que a suite do order-service usa para provar o que ela
    // aceita. Ate aqui os dois lados testavam com literais escritos
    // separadamente: um campo renomeado passava nos DOIS e so falhava em
    // producao (achados 5.1 e 6.3 do review do PR #61).
    const esperado = JSON.parse(
      readFileSync(join(__dirname, '../../../../../contracts/payment.expired.v1.json'), 'utf-8'),
    ) as Record<string, unknown>;

    const evento = montarEventoDeExpiracao(
      {
        paymentId: 'pay_contrato',
        orderId: 'ord_contrato',
        amountCents: 12990,
        currency: 'BRL',
      },
      new Date('2026-09-06T12:00:00.000Z'),
    );

    expect(evento.payload).toEqual(esperado);
    expect(evento.eventId).toBe(esperado.eventId);
  });
});
