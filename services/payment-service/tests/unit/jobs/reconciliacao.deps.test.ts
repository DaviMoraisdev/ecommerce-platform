import { montarDepsDeReconciliacao } from '../../../src/jobs/reconciliacao.deps';
import type { PaymentProvider } from '../../../src/providers/payment-provider.port';
import type { PaymentService } from '../../../src/services/payment.service';

function provedorFalso(ausenciaEDefinitiva: boolean) {
  return {
    ausenciaEDefinitiva,
    buscarCobrancaPorTentativa: jest.fn(async () => null),
  };
}

function servicoFalso() {
  return {
    aplicarDesfechoDeReconciliacao: jest.fn(async () => true),
    liberarTentativaPresa: jest.fn(async () => true),
  };
}

function montar(ausencia: boolean, janela = 15) {
  const provider = provedorFalso(ausencia);
  const service = servicoFalso();
  const deps = montarDepsDeReconciliacao(
    provider as unknown as PaymentProvider,
    service as unknown as PaymentService,
    janela,
  );
  return { provider, service, deps };
}

describe('montarDepsDeReconciliacao', () => {
  it('CASO D1: a garantia de ausencia vem do PROVEDOR, nao de um literal', () => {
    // Achado Q-4 da bateria. Um `true` fixo aqui desliga a protecao do achado
    // 3.1 inteira, e era a unica linha do caminho do dinheiro sem teste.
    expect(montar(false).deps.ausenciaEDefinitiva).toBe(false);
    expect(montar(true).deps.ausenciaEDefinitiva).toBe(true);
  });

  it('CASO D2: consultarProvedor delega com paymentId e attemptCount, nesta ordem', async () => {
    const { provider, deps } = montar(true);
    await deps.consultarProvedor('pay_1', 3);
    expect(provider.buscarCobrancaPorTentativa).toHaveBeenCalledWith('pay_1', 3);
  });

  it('CASO D3: aplicar e liberar delegam ao servico', async () => {
    const { service, deps } = montar(true);
    await deps.aplicar('tx_1', { providerRef: 'ch_1', state: 'SUCCEEDED', capturedAmountCents: 10 });
    await deps.liberar('tx_2');
    expect(service.aplicarDesfechoDeReconciliacao).toHaveBeenCalledWith('tx_1', {
      providerRef: 'ch_1',
      state: 'SUCCEEDED',
      capturedAmountCents: 10,
    });
    expect(service.liberarTentativaPresa).toHaveBeenCalledWith('tx_2');
  });

  it('CASO D4: a janela vem da configuracao, nao do default do tick', () => {
    expect(montar(true, 42).deps.janelaMinutos).toBe(42);
  });
});
