import type { Prisma } from '@prisma/client';

/**
 * PAGINACAO POR CHAVE, compartilhada pelas varreduras que percorrem
 * PaymentTransaction.
 *
 * Extraida no Bloco 6e, no SEGUNDO uso. A logica e sutil e ja tem teste
 * (CASOS J8 e J9 do 6b): duas copias dela divergiriam em silencio, e um cursor
 * que se comporta diferente do outro produz starvation que nenhum teste do
 * outro job pega.
 */

/** Ultima linha ja examinada neste ciclo. */
export interface CursorDaVarredura {
  createdAt: Date;
  id: string;
}

/**
 * Nao usa `skip` nem o `cursor` nativo do Prisma: offset se desloca quando uma
 * linha e resolvida no meio da varredura, e o cursor nativo LOCALIZA a linha
 * por id — se ela deixou de ser candidata, a pagina seguinte fica indefinida.
 * A comparacao lexicografica `(createdAt, id) > (cursor)` depende so de valores.
 */
export function apenasDepoisDoCursor(
  apos?: CursorDaVarredura,
): Prisma.PaymentTransactionWhereInput[] {
  if (apos === undefined) return [];

  return [
    {
      OR: [
        { createdAt: { gt: apos.createdAt } },
        { AND: [{ createdAt: apos.createdAt }, { id: { gt: apos.id } }] },
      ],
    },
  ];
}

/**
 * Mais antigas primeiro: sao as que ha mais tempo travam um cliente. O `id` e
 * desempate ESTAVEL — sem ele, duas linhas com o mesmo createdAt podem trocar
 * de posicao entre paginas e uma delas nunca ser lida.
 *
 * Funcao e nao constante: `orderBy` do Prisma espera array mutavel, e uma
 * constante compartilhada poderia ser mutada por um chamador distraido.
 */
export function ordenacaoDaVarredura(): Prisma.PaymentTransactionOrderByWithRelationInput[] {
  return [{ createdAt: 'asc' }, { id: 'asc' }];
}
