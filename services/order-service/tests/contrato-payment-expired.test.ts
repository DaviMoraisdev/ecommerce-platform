import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseExpiracao } from '../src/events/payment-events';

/**
 * Lado CONSUMIDOR do contrato de payment.expired.
 *
 * A fixture e a MESMA que a suite do payment-service usa para provar o que ela
 * gera. Produtor e consumidor sao arquivos de servicos diferentes, e ate aqui os
 * dois testavam com literais escritos separadamente: um campo renomeado de um
 * lado passava nos DOIS conjuntos e so falhava em producao (achados 5.1 e 6.3).
 */
const bruto = readFileSync(
  join(__dirname, '../../../contracts/payment.expired.v1.json'),
  'utf-8',
);

describe('contrato payment.expired', () => {
  it('CASO K1: o consumidor ACEITA exatamente o payload publicado', () => {
    const evento = parseExpiracao(bruto);

    expect(evento).not.toBeNull();
    expect(evento).toEqual({
      eventId: 'payment.expired:pay_contrato',
      paymentId: 'pay_contrato',
      orderId: 'ord_contrato',
      amountCents: 12990,
      currency: 'BRL',
      occurredAt: '2026-09-06T12:00:00.000Z',
    });
  });

  it('CASO K2: occurredAt fora do formato ISO e recusado', () => {
    // Achado 4.5: antes qualquer string passava, inclusive vazia ou com CR/LF.
    const comLixo = JSON.parse(bruto) as Record<string, unknown>;

    for (const invalido of ['', 'ontem', '2026-09-06', '2026-09-06T12:00:00Z\nfalso']) {
      expect(parseExpiracao(JSON.stringify({ ...comLixo, occurredAt: invalido }))).toBeNull();
    }
  });
});
