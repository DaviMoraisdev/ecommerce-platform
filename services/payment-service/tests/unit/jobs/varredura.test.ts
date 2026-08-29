import {
  criarVarredura,
  tickReconciliacao,
  type CursorDaVarredura,
  type ReconciliacaoDeps,
  type TentativaPresa,
} from '../../../src/jobs/reconciliacao';
import type { ChargeSnapshot } from '../../../src/providers/payment-provider.port';

const NASCIMENTO = new Date('2026-08-26T10:00:00.000Z');

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

function presa(over: Partial<TentativaPresa> = {}): TentativaPresa {
  return { id: 'tx_1', paymentId: 'pay_1', attemptCount: 1, createdAt: NASCIMENTO, ...over };
}

function deps(over: Partial<ReconciliacaoDeps> = {}): ReconciliacaoDeps {
  return {
    buscarPresas: jest.fn(async () => [presa()]),
    consultarProvedor: jest.fn(async () => snapshot()),
    aplicar: jest.fn(async () => true),
    liberar: jest.fn(async () => true),
    ausenciaEDefinitiva: true,
    agora: () => new Date('2026-08-26T12:00:00.000Z'),
    janelaMinutos: 15,
    lote: 20,
    ...over,
  };
}

describe('tickReconciliacao', () => {
  it('CASO S1: so considera tentativas ANTERIORES a janela', async () => {
    // A janela nao e otimizacao, e correcao: sem ela o job pegaria uma tentativa
    // cuja chamada HTTP ainda esta em voo e aplicaria desfecho por baixo dela.
    const d = deps();
    await tickReconciliacao(d);

    const [limite, lote] = (d.buscarPresas as jest.Mock).mock.calls[0];
    expect(limite).toEqual(new Date('2026-08-26T11:45:00.000Z'));
    expect(lote).toBe(20);
  });

  it('CASO S2: sem cobranca no provedor, LIBERA e nao aplica', async () => {
    const d = deps({ consultarProvedor: jest.fn(async () => null) });
    const resumo = await tickReconciliacao(d);

    expect(d.liberar).toHaveBeenCalledWith('tx_1');
    expect(d.aplicar).not.toHaveBeenCalled();
    expect(resumo.liberadas).toBe(1);
  });

  it('CASO S3: cobranca capturada, APLICA o desfecho', async () => {
    const d = deps();
    const resumo = await tickReconciliacao(d);

    expect(d.aplicar).toHaveBeenCalledWith('tx_1', expect.objectContaining({ state: 'SUCCEEDED' }));
    expect(d.liberar).not.toHaveBeenCalled();
    expect(resumo.aplicadas).toBe(1);
  });

  it('CASO S4: cobranca em processamento nao toca em nada', async () => {
    const d = deps({
      consultarProvedor: jest.fn(async () => snapshot({ state: 'PROCESSING', capturedAmountCents: 0 })),
    });
    const resumo = await tickReconciliacao(d);

    expect(d.aplicar).not.toHaveBeenCalled();
    expect(d.liberar).not.toHaveBeenCalled();
    expect(resumo.aguardando).toBe(1);
  });

  it('CASO S5: estado que o job nao sabe aplicar vai para triagem, sem tocar', async () => {
    const d = deps({
      consultarProvedor: jest.fn(async () => snapshot({ state: 'CANCELED', capturedAmountCents: 0 })),
    });
    const resumo = await tickReconciliacao(d);

    expect(d.aplicar).not.toHaveBeenCalled();
    expect(d.liberar).not.toHaveBeenCalled();
    expect(resumo.triagem).toBe(1);
  });

  it('CASO S6: falha numa tentativa NAO aborta o lote', async () => {
    // Provedor fora do ar para um item e transiente. Abortar o lote deixaria
    // todas as outras presas por causa de uma — e a proxima execucao repetiria
    // o mesmo item primeiro, num ciclo que nunca avanca.
    const consultar = jest
      .fn()
      .mockRejectedValueOnce(new Error('provedor fora do ar'))
      .mockResolvedValueOnce(snapshot());
    const d = deps({
      buscarPresas: jest.fn(async () => [
        presa({ id: 'tx_ruim', paymentId: 'pay_1' }),
        presa({ id: 'tx_bom', paymentId: 'pay_2' }),
      ]),
      consultarProvedor: consultar,
    });

    const resumo = await tickReconciliacao(d);

    expect(resumo.falhas).toBe(1);
    expect(resumo.aplicadas).toBe(1);
    expect(d.aplicar).toHaveBeenCalledWith('tx_bom', expect.anything());
  });

  it('CASO S7: item cujo CAS foi perdido nao conta como aplicado', async () => {
    // Outra execucao ganhou. Contar como aplicado inflaria a metrica e
    // esconderia que este tick nao fez nada.
    const d = deps({ aplicar: jest.fn(async () => false) });
    const resumo = await tickReconciliacao(d);

    expect(resumo.aplicadas).toBe(0);
    expect(resumo.examinadas).toBe(1);
  });

  it('CASO S8: item nao-acionavel no primeiro lote NAO impede os posteriores', async () => {
    // Achado 4.1 do review do PR #57. `triagem` (como `aguardar` e falha) nao
    // altera a linha: ela continua PENDING sem providerRef e continua entre as
    // mais antigas. Sem paginar, o mesmo lote voltaria a cada ciclo e nenhuma
    // tentativa posterior seria examinada — bastava o provedor cair uma vez.
    const paginas: TentativaPresa[][] = [
      [presa({ id: 'tx_travado_a', paymentId: 'pay_1' }), presa({ id: 'tx_travado_b', paymentId: 'pay_2' })],
      [presa({ id: 'tx_novo', paymentId: 'pay_2' })],
      [],
    ];
    const d = deps({
      lote: 2,
      buscarPresas: jest.fn(async () => paginas.shift() ?? []),
      consultarProvedor: jest
        .fn()
        .mockResolvedValueOnce(snapshot({ state: 'CANCELED', capturedAmountCents: 0 }))
        .mockResolvedValueOnce(snapshot({ state: 'CANCELED', capturedAmountCents: 0 }))
        .mockResolvedValueOnce(snapshot()),
    });

    const resumo = await tickReconciliacao(d);

    expect(resumo.triagem).toBe(2);
    expect(resumo.aplicadas).toBe(1);
    expect(d.aplicar).toHaveBeenCalledWith('tx_novo', expect.anything());
    expect(resumo.truncada).toBe(false);

    // O cursor da 2a busca tem de ser a ULTIMA linha da 1a pagina: e o que
    // garante que a varredura anda em vez de reler o mesmo lote.
    const [, , cursor] = (d.buscarPresas as jest.Mock).mock.calls[1];
    // Pagina de DOIS itens: se o cursor viesse do primeiro, a varredura releria
    // o segundo a cada ciclo. E o que distingue cursor certo de cursor qualquer.
    expect(cursor).toEqual({ createdAt: NASCIMENTO, id: 'tx_travado_b' });
  });

  it('CASO S9: o teto de lotes encerra o ciclo e marca truncada', async () => {
    // O teto existe para o ciclo nao virar varredura ilimitada. Marcar
    // `truncada` e o que distingue "acabou a fila" de "parei no meio".
    let n = 0;
    const d = deps({
      lote: 1,
      maxLotes: 2,
      buscarPresas: jest.fn(async () => {
        n += 1;
        return [presa({ id: 'tx_' + String(n) })];
      }),
      consultarProvedor: jest.fn(async () => snapshot({ state: 'PROCESSING', capturedAmountCents: 0 })),
    });

    const resumo = await tickReconciliacao(d);

    expect(d.buscarPresas).toHaveBeenCalledTimes(2);
    expect(resumo.examinadas).toBe(2);
    expect(resumo.aguardando).toBe(2);
    expect(resumo.truncada).toBe(true);
  });

  it('CASO S10: sem garantia de ausencia definitiva, a varredura NAO libera', async () => {
    // R7 prova a decisao pura; este prova a FIACAO. Fixar `true` dentro do tick
    // passaria pelo R7 sem deixar rastro — o job liberaria com qualquer provedor.
    const d = deps({
      ausenciaEDefinitiva: false,
      consultarProvedor: jest.fn(async () => null),
    });

    const resumo = await tickReconciliacao(d);

    expect(d.liberar).not.toHaveBeenCalled();
    expect(resumo.liberadas).toBe(0);
    expect(resumo.triagem).toBe(1);
  });

  it('CASO S11: o cursor sobrevive ao teto e o ciclo seguinte continua de onde parou', async () => {
    // Achado 4.1 da 2a rodada. Com o cursor local ao tick, cada ciclo relia os
    // mesmos maxLotes*lote itens e o seguinte nunca era alcancado: starvation
    // deslocado de 20 para 100 registros, nao eliminado.
    const todas = [
      presa({ id: 'tx_a', paymentId: 'pay_a' }),
      presa({ id: 'tx_b', paymentId: 'pay_b' }),
      presa({ id: 'tx_c', paymentId: 'pay_c' }),
    ];
    const buscarPresas = jest.fn(async (_limite: Date, lote: number, apos?: CursorDaVarredura) => {
      const inicio = apos ? todas.findIndex((t) => t.id === apos.id) + 1 : 0;
      return todas.slice(inicio, inicio + lote);
    });
    const d = deps({
      lote: 1,
      maxLotes: 2,
      buscarPresas,
      consultarProvedor: jest.fn(async () => snapshot({ state: 'PROCESSING', capturedAmountCents: 0 })),
    });

    const varrer = criarVarredura(d);

    const primeiro = await varrer();
    expect(primeiro.truncada).toBe(true);
    expect(primeiro.proximoCursor).toEqual({ createdAt: NASCIMENTO, id: 'tx_b' });

    const segundo = await varrer();

    // Sem memoria entre ciclos, a sequencia seria pay_a, pay_b, pay_a, pay_b —
    // e pay_c ficaria preso para sempre.
    expect((d.consultarProvedor as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      'pay_a',
      'pay_b',
      'pay_c',
    ]);
    // Fila esgotada: o proximo ciclo recomeca do inicio, senao os mais antigos
    // deixariam de ser reavaliados.
    expect(segundo.proximoCursor).toBeNull();
  });
});
