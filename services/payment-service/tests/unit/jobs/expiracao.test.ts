import { decidirExpiracao } from '../../../src/jobs/expiracao';
import type { ChargeSnapshot } from '../../../src/providers/payment-provider.port';

function snapshot(over: Partial<ChargeSnapshot> = {}): ChargeSnapshot {
  return {
    providerRef: 'ch_1',
    state: 'CANCELED',
    amountCents: 12990,
    capturedAmountCents: 0,
    refundedAmountCents: 0,
    ...over,
  };
}

describe('decidirExpiracao', () => {
  it('CASO X1: cobranca CANCELADA no provedor expira o pagamento', () => {
    // Unico caminho que produz EXPIRED. O comando pegou e o dinheiro reservado
    // foi liberado no cartao do cliente.
    expect(decidirExpiracao(snapshot())).toEqual({ tipo: 'expirar' });
  });

  it('CASO X2: cobranca CAPTURADA aplica a captura, NAO expira', () => {
    // O ramo que mais custa dinheiro. O provedor capturou antes do comando;
    // marcar EXPIRED registraria como expirado um pagamento que cobrou o
    // cliente, e o pedido nunca seria liberado.
    const acao = decidirExpiracao(
      snapshot({ state: 'SUCCEEDED', capturedAmountCents: 12990 }),
    );

    expect(acao).toEqual({
      tipo: 'aplicar',
      resultado: {
        providerRef: 'ch_1',
        state: 'SUCCEEDED',
        capturedAmountCents: 12990,
      },
    });
  });

  it('CASO X3: recusa COM codigo aplica a falha pelo caminho normal', () => {
    const acao = decidirExpiracao(
      snapshot({ state: 'DECLINED', declineCode: 'expired_card' }),
    );

    expect(acao).toMatchObject({
      tipo: 'aplicar',
      resultado: { state: 'DECLINED', declineCode: 'expired_card' },
    });
  });

  it('CASO X4: recusa SEM codigo vai para triagem, nao vira recusa inventada', () => {
    // Espelha o CASO R6 da reconciliacao: declineCode e opcional no snapshot e
    // obrigatorio no ChargeResult. Fachada viraria mentira permanente na
    // resposta congelada.
    expect(decidirExpiracao(snapshot({ state: 'DECLINED' }))).toMatchObject({
      tipo: 'triagem',
    });
  });

  it('CASO X5: cobranca ainda em PROCESSING vai para triagem, nao para espera', () => {
    // A diferenca de postura em relacao a reconciliacao. La, PROCESSING e
    // `aguardar` — o job so perguntou. Aqui ja COMANDAMOS o cancelamento: se a
    // cobranca segue andando, e anomalia, e esperar em silencio esconderia.
    expect(decidirExpiracao(snapshot({ state: 'PROCESSING' }))).toMatchObject({
      tipo: 'triagem',
      motivo: expect.stringContaining('processamento'),
    });
  });
});
