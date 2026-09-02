import {
  chaveDeCancelamento,
  tickExpiracao,
  type ExpiracaoDeps,
  type TentativaExpirando,
} from '../../../src/jobs/expiracao';
import { montarDepsDeExpiracao } from '../../../src/jobs/expiracao.deps';
import {
  ChargeNotCancelableError,
  ProviderUnavailableError,
  type ChargeSnapshot,
  type PaymentProvider,
} from '../../../src/providers/payment-provider.port';
import type { PaymentService } from '../../../src/services/payment.service';

function candidata(over: Partial<TentativaExpirando> = {}): TentativaExpirando {
  return {
    id: 'tx_1',
    paymentId: 'pay_1',
    attemptCount: 2,
    providerRef: 'ch_1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

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

function deps(over: Partial<ExpiracaoDeps> = {}): ExpiracaoDeps {
  return {
    buscarExpirando: jest.fn(async () => [candidata()]),
    cancelarCobranca: jest.fn(async () => snapshot()),
    consultarCobranca: jest.fn(async () => snapshot()),
    expirar: jest.fn(async () => true),
    aplicar: jest.fn(async () => true),
    ...over,
  };
}

describe('tickExpiracao', () => {
  it('CASO Y1: cobranca cancelada no provedor expira a tentativa', async () => {
    const d = deps();
    const resumo = await tickExpiracao(d);

    expect(resumo).toMatchObject({ examinadas: 1, expiradas: 1, aplicadas: 0, falhas: 0 });
    expect(d.expirar).toHaveBeenCalledWith('tx_1', 'ch_1');
  });

  it('CASO Y2: recusa por cobranca CAPTURADA vira consulta e aplica a captura', async () => {
    // O ramo que mais custa dinheiro. A recusa NAO e falha: e o provedor
    // dizendo que capturou. Tratada como falha generica, um pagamento cobrado
    // do cliente ficaria preso para sempre.
    const d = deps({
      cancelarCobranca: jest.fn(async () => {
        throw new ChargeNotCancelableError('cobranca capturada nao pode ser cancelada');
      }),
      consultarCobranca: jest.fn(async () =>
        snapshot({ state: 'SUCCEEDED', capturedAmountCents: 12990 }),
      ),
    });

    const resumo = await tickExpiracao(d);

    expect(resumo).toMatchObject({ expiradas: 0, aplicadas: 1, falhas: 0 });
    expect(d.consultarCobranca).toHaveBeenCalledWith('ch_1');
    expect(d.aplicar).toHaveBeenCalledWith(
      'tx_1',
      'ch_1',
      expect.objectContaining({ state: 'SUCCEEDED', capturedAmountCents: 12990 }),
    );
  });

  it('CASO Y3: falha TECNICA nao vira desfecho e nao interrompe a varredura', async () => {
    const outra = candidata({ id: 'tx_2', paymentId: 'pay_2' });
    let chamadas = 0;
    const d = deps({
      buscarExpirando: jest.fn(async () => [candidata(), outra]),
      cancelarCobranca: jest.fn(async () => {
        chamadas += 1;
        if (chamadas === 1) throw new ProviderUnavailableError('provedor fora');
        return snapshot({ providerRef: 'ch_1' });
      }),
    });

    const resumo = await tickExpiracao(d);

    // A primeira falhou, a segunda seguiu: uma tentativa nao-acionavel nao pode
    // segurar as demais (achado 4.1 do PR #57).
    expect(resumo).toMatchObject({ examinadas: 2, falhas: 1, expiradas: 1 });
    expect(d.expirar).toHaveBeenCalledTimes(1);
    expect(d.expirar).toHaveBeenCalledWith('tx_2', 'ch_1');
  });

  it('CASO Y4: a chave do cancelamento e DERIVADA e tem prefixo proprio', async () => {
    // Com provedor real a chave de idempotencia e global por conta: reusar a do
    // createCharge (`paymentId:attemptCount`) faria o provedor devolver a
    // resposta EM CACHE da criacao em vez de cancelar.
    const d = deps();
    await tickExpiracao(d);

    expect(chaveDeCancelamento('pay_1', 2)).toBe('cancel:pay_1:2');
    expect(d.cancelarCobranca).toHaveBeenCalledWith('ch_1', 'cancel:pay_1:2');
  });

  it('CASO Y5: a fiacao liga o cancelamento ao PROVEDOR, nao a um literal', async () => {
    // Mesma razao dos CASOS D1-D4 do 6b: enquanto a fiacao nao tem teste, trocar
    // um alvo por outro desliga a protecao sem derrubar nada.
    const cancelCharge = jest.fn(async () => snapshot());
    const getCharge = jest.fn(async () => snapshot());
    const provider = { cancelCharge, getCharge } as unknown as PaymentProvider;
    const service = {
      expirarTentativa: jest.fn(async () => true),
      aplicarDesfechoDeExpiracao: jest.fn(async () => true),
    } as unknown as PaymentService;

    const d = montarDepsDeExpiracao(provider, service, 30);
    await d.cancelarCobranca('ch_9', 'cancel:pay_9:1');
    await d.consultarCobranca('ch_9');

    expect(cancelCharge).toHaveBeenCalledWith({
      providerRef: 'ch_9',
      idempotencyKey: 'cancel:pay_9:1',
    });
    expect(getCharge).toHaveBeenCalledWith('ch_9');
    expect(d.janelaMinutos).toBe(30);
  });
});
