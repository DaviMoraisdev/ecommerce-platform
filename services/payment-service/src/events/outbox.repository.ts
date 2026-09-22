import type { Prisma, OutboxEvent } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { getPrisma } from '../config/database';

export interface OutboxInput {
  eventId: string;
  routingKey: string;
  payload: Prisma.InputJsonValue;
}

/**
 * Recebe o `tx`: o evento e gravado na MESMA transacao do efeito — ou os dois
 * commitam, ou nenhum. E o que impede pagamento capturado sem evento (pedido
 * nunca fica sabendo) e evento sem captura (pedido pago que nao foi).
 */
export async function enqueue(tx: Prisma.TransactionClient, ev: OutboxInput): Promise<void> {
  // ON CONFLICT DO NOTHING, e NAO create + catch do P2002. No Postgres uma
  // instrucao que falha ENVENENA a transacao ("current transaction is
  // aborted"): capturar o erro nao devolveria a transacao ao chamador, o efeito
  // seria desfeito do mesmo jeito. Uma insercao que nao falha nao envenena.
  const { count } = await tx.outboxEvent.createMany({
    data: [{ eventId: ev.eventId, routingKey: ev.routingKey, payload: ev.payload }],
    skipDuplicates: true,
  });
  if (count === 1) return;

  // Ja existe um evento com este eventId. Pular em silencio engoliria o caso
  // perigoso — o MESMO id carregando outro fato, que e bug do produtor.
  const existente = await tx.outboxEvent.findUnique({ where: { eventId: ev.eventId } });
  if (existente !== null && mesmoFato(existente, ev)) return;

  // Fail-closed: `existente` nulo apos count 0 nao deveria acontecer (o ON
  // CONFLICT so cede quando a linha concorrente commitou), e se acontecer nao
  // ha como provar que e o mesmo fato.
  throw new ConflitoDeEventoError(ev.eventId);
}

/**
 * Campos do payload que NAO fazem parte do fato: metadado do instante em que o
 * evento foi MONTADO. Dois escritores do mesmo fato os produzem diferentes.
 *
 * Lista FECHADA e explicita. Uma heuristica ("ignora o que parece data")
 * engoliria conflito real no dia em que um campo de negocio tiver forma de data.
 */
const CAMPOS_DE_MONTAGEM: ReadonlySet<string> = new Set(['occurredAt']);

function oFato(payload: unknown): unknown {
  // Ida e volta por JSON: e a normalizacao que o valor gravado em jsonb sofreu
  // (Date vira string, undefined some). Sem ela, uma duplicata legitima poderia
  // parecer conflito.
  const normal: unknown = JSON.parse(JSON.stringify(payload));
  if (normal === null || typeof normal !== 'object' || Array.isArray(normal)) return normal;
  return Object.fromEntries(Object.entries(normal).filter(([k]) => !CAMPOS_DE_MONTAGEM.has(k)));
}

/**
 * Dois eventos com o mesmo eventId descrevem o MESMO fato? Mesma routing key e
 * mesmo payload, fora os campos de montagem. isDeepStrictEqual compara objetos
 * sem depender da ordem das chaves — e o jsonb do Postgres REORDENA as chaves ao
 * gravar, entao comparar por texto acusaria conflito em duplicata legitima.
 */
export function mesmoFato(
  a: { routingKey: string; payload: unknown },
  b: { routingKey: string; payload: unknown },
): boolean {
  return a.routingKey === b.routingKey && isDeepStrictEqual(oFato(a.payload), oFato(b.payload));
}

/**
 * Mesmo eventId, fato diferente. Lancado DENTRO da transacao do efeito, que e
 * desfeita inteira. Pela rota de webhook cai na populacao A do Bloco 6c
 * (FAILED, attempts++), limitada pelo teto de quarentena — nao ha retry infinito.
 * A mensagem leva so o eventId: o payload pode carregar valores.
 */
export class ConflitoDeEventoError extends Error {
  constructor(readonly eventId: string) {
    super('evento ja gravado com outro conteudo: ' + eventId);
    this.name = 'ConflitoDeEventoError';
  }
}

/** PENDING mais antigos primeiro; desempate por id porque createdAt tem ms. */
export async function fetchPending(limite: number): Promise<OutboxEvent[]> {
  return getPrisma().outboxEvent.findMany({
    where: { status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limite,
  });
}

export async function markSent(id: string): Promise<void> {
  await getPrisma().outboxEvent.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date() },
  });
}

/**
 * Falha ao publicar MANTEM PENDING: abandonar o evento quebraria o
 * at-least-once. `attempts` e `lastError` sao so observabilidade. Teto e
 * quarentena de evento venenoso ficam para o Bloco 6, junto do job.
 */
export async function markRetry(id: string, erro: string): Promise<void> {
  await getPrisma().outboxEvent.update({
    where: { id },
    data: { attempts: { increment: 1 }, lastError: erro.slice(0, 500) },
  });
}
