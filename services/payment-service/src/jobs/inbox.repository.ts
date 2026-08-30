import { WebhookStatus } from '@prisma/client';
import { getPrisma } from '../config/database';

/**
 * Eventos do inbox que ficaram SEM CONCLUSAO e que nenhuma requisicao vai mais
 * revisitar.
 *
 * O caminho sincrono (teto e quarentena por idade) so age quando uma reentrega
 * CHEGA. Se o provedor desistir de reentregar — ou se o processo cair entre
 * gravar a linha e aplicar o efeito —, a linha fica em RECEIVED ou FAILED para
 * sempre, e ninguem fica sabendo. Esta varredura torna isso visivel.
 *
 * NAO REPROCESSA, de proposito: reconstruir o WebhookEventPayload a partir do
 * `payload` gravado seria infiel, porque ele passa por sanitizacao com
 * allowlist. Aplicar efeito financeiro a partir de dado empobrecido e pior que
 * deixar o evento para triagem.
 *
 * `lastError` NAO e sobrescrito: nas linhas FAILED ele guarda a causa real, que
 * e exatamente o que a triagem precisa. O que a varredura registra e o par
 * (status QUARANTINED, processedAt). Para distinguir quem quarentenou:
 * `attempts >= teto` veio do teto; abaixo dele, veio da idade ou desta varredura.
 */
export async function quarentenarOrfaos(limite: Date, lote: number): Promise<number> {
  const emAberto = { status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] } };

  const orfaos = await getPrisma().webhookEvent.findMany({
    where: { ...emAberto, receivedAt: { lt: limite } },
    orderBy: { receivedAt: 'asc' },
    take: lote,
    select: { id: true },
  });
  if (orfaos.length === 0) return 0;

  const { count } = await getPrisma().webhookEvent.updateMany({
    where: {
      id: { in: orfaos.map((o) => o.id) },
      // Reavalia o estado: entre a leitura e a escrita uma reentrega pode ter
      // concluido a linha. Sem isto a varredura sobrescreveria um PROCESSED.
      ...emAberto,
    },
    data: { status: WebhookStatus.QUARANTINED, processedAt: new Date() },
  });
  return count;
}
