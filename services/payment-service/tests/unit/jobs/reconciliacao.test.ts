import { decidirReconciliacao } from '../../../src/jobs/reconciliacao';
import type { ChargeSnapshot } from '../../../src/providers/payment-provider.port';

function snapshot(over: Partial<ChargeSnapshot> = {}): ChargeSnapshot {
  return {
    providerRef: 'ch_1',
    state: 'SUCCEEDED',
    amountCents: 12990,
    capturedAmountCents: 12990,
    refundedAmountCents: 0,
    ...over,
  };
}

describe('decidirReconciliacao', () => {
  it('CASO R1: ausencia DEFINITIVA de cobranca LIBERA a tentativa', () => {
    // null nao e erro: e a unica evidencia que autoriza refazer a tentativa.
    // A chamada nunca chegou, entao attemptCount + 1 (e chave de provedor nova)
    // nao pode causar segunda cobranca — desde que a ausencia seja definitiva.
    expect(decidirReconciliacao(null, true)).toEqual({ tipo: 'liberar' });
  });

  it('CASO R2: cobranca capturada vira desfecho de sucesso', () => {
    const acao = decidirReconciliacao(snapshot({ capturedAmountCents: 12990 }), true);
    expect(acao).toEqual({
      tipo: 'aplicar',
      resultado: { providerRef: 'ch_1', state: 'SUCCEEDED', capturedAmountCents: 12990 },
    });
  });

  it('CASO R3: cobranca recusada vira desfecho de recusa, com o codigo', () => {
    const acao = decidirReconciliacao(
      snapshot({ state: 'DECLINED', capturedAmountCents: 0, declineCode: 'insufficient_funds' }),
      true,
    );
    expect(acao).toEqual({
      tipo: 'aplicar',
      resultado: {
        providerRef: 'ch_1',
        state: 'DECLINED',
        capturedAmountCents: 0,
        declineCode: 'insufficient_funds',
      },
    });
  });

  it('CASO R4: cobranca ainda em processamento NAO e tocada', () => {
    // O provedor nao decidiu. Aplicar qualquer coisa aqui seria inventar
    // desfecho; o webhook e quem resolve.
    expect(
      decidirReconciliacao(snapshot({ state: 'PROCESSING', capturedAmountCents: 0 }), true),
    ).toEqual({ tipo: 'aguardar' });
  });

  it('CASO R5: cobranca CANCELADA vai para triagem, nao e aplicada', () => {
    // ChargeSnapshot admite CANCELED; ChargeResult nao. Traduzir exigiria
    // inventar um desfecho que o tipo do fluxo normal nao representa. Cancelar
    // e o outro item do Bloco 6 (expiracao da janela), e misturar os dois
    // repetiria o problema de escopo que alongou o 5b.
    const acao = decidirReconciliacao(snapshot({ state: 'CANCELED', capturedAmountCents: 0 }), true);
    expect(acao).toMatchObject({ tipo: 'triagem' });
  });

  it('CASO R6: recusa SEM codigo vai para triagem, nao vira recusa inventada', () => {
    // declineCode e opcional em ChargeSnapshot e OBRIGATORIO em ChargeResult.
    // Preencher com um valor de fachada gravaria uma mentira na resposta
    // congelada — que e devolvida ao cliente em todo replay, para sempre.
    // Preso e visivel e melhor que liberado com dado inventado.
    const acao = decidirReconciliacao(snapshot({ state: 'DECLINED', capturedAmountCents: 0 }), true);
    expect(acao).toMatchObject({ tipo: 'triagem' });
  });

  it('CASO R7: ausencia SEM garantia de ser definitiva vai para TRIAGEM, nao libera', () => {
    // Achado 3.1 do review do PR #57. Num provedor eventualmente consistente,
    // `null` tambem significa "cobrou e ainda nao aparece". Liberar ali habilita
    // uma tentativa nova com chave de provedor nova — segunda cobranca, que e o
    // unico ponto do job em que dinheiro pode ser duplicado.
    const acao = decidirReconciliacao(null, false);
    expect(acao).toMatchObject({ tipo: 'triagem' });
  });
});
