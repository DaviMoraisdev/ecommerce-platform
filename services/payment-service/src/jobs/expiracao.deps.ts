import type { ExpiracaoDeps } from './expiracao';
import { buscarTentativasExpirando } from './expiracao.repository';
import type { PaymentProvider, ProviderRef } from '../providers/payment-provider.port';
import type { PaymentService } from '../services/payment.service';

/**
 * Montagem das dependencias da varredura de expiracao.
 *
 * Funcao pura e testavel, pelo mesmo motivo do 6b (achado Q-4): enquanto a
 * fiacao vive dentro do `server.ts`, trocar um alvo por outro desliga uma
 * protecao inteira sem derrubar UM teste — o bootstrap injeta as deps e nunca
 * alcanca esta ligacao.
 */
export function montarDepsDeExpiracao(
  provider: PaymentProvider,
  service: PaymentService,
  janelaMinutos: number,
): ExpiracaoDeps {
  return {
    buscarExpirando: buscarTentativasExpirando,
    cancelarCobranca: (providerRef, idempotencyKey) =>
      provider.cancelCharge({ providerRef: providerRef as ProviderRef, idempotencyKey }),
    consultarCobranca: (providerRef) => provider.getCharge(providerRef as ProviderRef),
    expirar: (transactionId, providerRef) => service.expirarTentativa(transactionId, providerRef),
    aplicar: (transactionId, providerRef, resultado) =>
      service.aplicarDesfechoDeExpiracao(transactionId, providerRef, resultado),
    janelaMinutos,
  };
}
