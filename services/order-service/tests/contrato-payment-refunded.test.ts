import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReembolso } from '../src/events/payment-events';

/**
 * Lado CONSUMIDOR do contrato de payment.refunded (Bloco 7b).
 *
 * A fixture e a MESMA que o CASO E3 da suite do payment-service usa para provar
 * o que ele gera. Um campo renomeado de um lado derruba pelo menos um dos dois —
 * que e a unica forma de a duplicacao do contrato entre servicos nao virar
 * divergencia silenciosa.
 */
const bruto = readFileSync(
  join(__dirname, '../../../contracts/payment.refunded.v1.json'),
  'utf-8',
);

describe('contrato payment.refunded', () => {
  it('CASO K3: o consumidor ACEITA exatamente o payload publicado', () => {
    const evento = parseReembolso(bruto);

    expect(evento).not.toBeNull();
    expect(evento).toEqual({
      eventId: 'payment.refunded:re_contrato',
      paymentId: 'pay_contrato',
      orderId: 'ord_contrato',
      providerRefundRef: 're_contrato',
      capturedAmountCents: 12990,
      refundedAmountCents: 5000,
      refundAmountCents: 3000,
      currency: 'BRL',
      occurredAt: '2026-09-10T12:00:00.000Z',
    });
  });

  it('CASO K4: eventId que NAO deriva do providerRefundRef e recusado', () => {
    // A propriedade que separa este evento dos outros dois. Captura e expiracao
    // amarram o eventId ao pagamento; aqui a amarracao e ao ESTORNO, porque ha
    // muitos por pagamento. Trocar a referencia mantendo o eventId simula
    // exatamente o que um produtor mal implementado — ou hostil — faria.
    const o = JSON.parse(bruto) as Record<string, unknown>;

    expect(parseReembolso(JSON.stringify({ ...o, providerRefundRef: 're_OUTRO' }))).toBeNull();
  });

  it('CASO K5: numeros que nao fecham sao recusados', () => {
    // Fail-closed sobre dinheiro. O produtor e nosso, mas mensagem em fila e
    // superficie de ataque, e a alternativa a recusar aqui e mover o valor do
    // pedido com numeros incoerentes.
    const o = JSON.parse(bruto) as Record<string, unknown>;

    const incoerentes = [
      { refundedAmountCents: 13000 }, // acumulado acima do capturado
      { refundAmountCents: 6000 }, // delta acima do acumulado
      { refundAmountCents: 0 }, // movimentacao de valor zero
      { capturedAmountCents: 0 }, // estorno sobre cobranca sem captura
    ];

    for (const campo of incoerentes) {
      expect(parseReembolso(JSON.stringify({ ...o, ...campo }))).toBeNull();
    }
  });
});
