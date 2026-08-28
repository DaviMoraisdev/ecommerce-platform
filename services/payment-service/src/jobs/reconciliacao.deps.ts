import type { ReconciliacaoDeps } from './reconciliacao';
import { buscarTentativasPresas } from './reconciliacao.repository';
import type { PaymentProvider } from '../providers/payment-provider.port';
import type { PaymentService } from '../services/payment.service';

/**
 * Montagem das dependencias do job, separada do ponto de entrada.
 *
 * Existe por causa do achado Q-4 da bateria do Bloco 6b: enquanto isto vivia
 * dentro do `server.ts`, trocar `provider.ausenciaEDefinitiva` por `true`
 * desligava a protecao do achado 3.1 sem derrubar UM teste sequer — o
 * `bootstrap.test.ts` injeta as deps e nunca alcanca esta fiacao. Funcao pura e
 * testavel sem mock de modulo; o `server.ts` volta a ser so o ponto de entrada.
 */
export function montarDepsDeReconciliacao(
  provider: PaymentProvider,
  service: PaymentService,
  janelaMinutos: number,
): ReconciliacaoDeps {
  return {
    buscarPresas: buscarTentativasPresas,
    consultarProvedor: (paymentId, attemptCount) =>
      provider.buscarCobrancaPorTentativa(paymentId, attemptCount),
    aplicar: (transactionId, resultado) =>
      service.aplicarDesfechoDeReconciliacao(transactionId, resultado),
    liberar: (transactionId) => service.liberarTentativaPresa(transactionId),
    // SEMPRE do provedor. Um literal aqui restaura o defeito do achado 3.1: o
    // job voltaria a liberar tentativa presa com qualquer adapter, inclusive um
    // cuja consulta nao garante ausencia definitiva.
    ausenciaEDefinitiva: provider.ausenciaEDefinitiva,
    janelaMinutos,
  };
}
