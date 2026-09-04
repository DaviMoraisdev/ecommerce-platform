import { Prisma } from '@prisma/client';
import { ResultadoAplicacao } from '../events/payments.consumer';

/**
 * Mecanica compartilhada pelos handlers do inbox.
 *
 * Extraida no Bloco 6f, no segundo uso (captura e expiracao). Nao e estetica:
 * o `alvoDoP2002` decide se uma colisao vira ACK de duplicata ou reprocessa,
 * e duas copias que divirjam produzem ack sobre transacao REVERTIDA — evento
 * perdido em silencio. O compilador nao pega esse tipo de divergencia.
 */

/**
 * Erro de controle: desfecho legitimo que NAO deve deixar rastro.
 *
 * O invariante do inbox e "linha existe se e somente se o efeito aconteceu".
 * Como o insert do inbox e a primeira coisa da transacao, os desfechos sem
 * efeito precisam DESFAZER a transacao — e a unica forma de abortar uma
 * $transaction interativa e lancar. Commitar a marca de um evento que nao
 * produziu efeito faria a redentrega ser lida como duplicata: o mesmo buraco do
 * claim em armazenamento separado, dentro de um banco so.
 */
export class SemEfeito extends Error {
  constructor(readonly resultado: ResultadoAplicacao) {
    super('desfecho sem efeito');
  }
}

// P2002 nao e uma coisa so: pode vir do @unique do inbox (duplicata de verdade)
// ou do unique parcial de pending_compensations (corrida). O formato do
// meta.target varia entre array de campos e nome de indice, entao normalizamos.
export function alvoDoP2002(err: Prisma.PrismaClientKnownRequestError): string {
  const alvo = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(alvo)) return alvo.join(',');
  return typeof alvo === 'string' ? alvo : '';
}
