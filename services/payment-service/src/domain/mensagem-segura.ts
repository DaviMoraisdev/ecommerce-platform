import { Prisma } from '@prisma/client';

/**
 * Sanitizador de mensagem de erro para log e para colunas de trilha.
 *
 * Extraido do WebhookService no Bloco 6e (achado 3.1 do review do PR #60): a
 * varredura de expiracao logava `erro.message` cru, e um adaptador que inclua
 * corpo de resposta, referencia externa ou token na mensagem despejaria isso
 * no log. Modulo proprio, e nao copia: duas versoes de um sanitizador
 * divergem em SILENCIO — uma vaza, a outra nao, e o compilador nao ve.
 */
/**
 * Mensagem gravada em lastError. NUNCA a mensagem original: erro de Prisma
 * carrega nome de tabela e coluna, e o inbox e lido em triagem operacional.
 */
export function mensagemSegura(erro: unknown): string {
  if (erro instanceof Prisma.PrismaClientKnownRequestError) {
    return `falha de banco (${erro.code})`;
  }
  return 'falha inesperada no processamento do webhook';
}
