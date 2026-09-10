import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  montarEventoDeReembolso,
  type PayloadDeReembolso,
} from '../../../src/events/payment.events';
import { ROUTING_PAYMENT_REFUNDED, eventIdDeReembolso } from '../../../src/events/topology';

/**
 * Fixture na RAIZ do repositorio, lida pelas suites dos DOIS servicos. E o que
 * faz divergencia entre produtor e consumidor quebrar pelo menos um lado —
 * padrao estabelecido no Bloco 6f com o payment.expired.
 */
const FIXTURE = path.resolve(__dirname, '../../../../../contracts/payment.refunded.v1.json');

describe('montarEventoDeReembolso (Bloco 7b)', () => {
  const base = {
    paymentId: 'pay_contrato',
    orderId: 'ord_contrato',
    currency: 'BRL',
    capturedAmountCents: 12990,
    refundedAmountCents: 5000,
    refundAmountCents: 3000,
    providerRefundRef: 're_contrato',
  };

  it('CASO E1: o eventId deriva da referencia do ESTORNO', () => {
    const ev = montarEventoDeReembolso(base, new Date('2026-09-10T12:00:00.000Z'));

    expect(ev.eventId).toBe('payment.refunded:re_contrato');
    expect(ev.eventId).toBe(eventIdDeReembolso('re_contrato'));
    expect(ev.routingKey).toBe(ROUTING_PAYMENT_REFUNDED);
  });

  it('CASO E2: dois estornos do MESMO pagamento produzem eventIds DIFERENTES', () => {
    // A propriedade que JUSTIFICA a quebra de padrao. eventIdDeCaptura deriva do
    // paymentId porque ha no maximo UMA captura por pagamento; reembolsos sao
    // muitos, e id derivado do pagamento faria o segundo colidir no @unique da
    // outbox — colisao que hoje sobe sem tratamento (divida do Bloco 9).
    const primeiro = montarEventoDeReembolso({ ...base, providerRefundRef: 're_1' }, new Date());
    const segundo = montarEventoDeReembolso({ ...base, providerRefundRef: 're_2' }, new Date());

    expect(primeiro.eventId).not.toBe(segundo.eventId);
  });

  it('CASO E3: o payload bate com a fixture de contrato compartilhada', () => {
    const esperado = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as PayloadDeReembolso;

    const ev = montarEventoDeReembolso(base, new Date(esperado.occurredAt));

    // Metade PRODUTORA do contrato. A consumidora entra no B3, lendo a MESMA
    // fixture: se um lado mudar de forma, o outro cai.
    expect(ev.payload).toEqual(esperado);
  });
});
