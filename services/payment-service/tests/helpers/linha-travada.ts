import type { PrismaClient } from '@prisma/client';

export interface ResultadoDaDisputa<T> {
  resultados: PromiseSettledResult<T>[];
  /** Disputantes que o Postgres viu ESPERANDO lock antes de ele ser solto. */
  bloqueados: number;
}

/**
 * Forca a sobreposicao de N disputantes sobre a MESMA linha de `payments`.
 *
 * `Promise.all` nao e teste de concorrencia: quando as chamadas serializam, o
 * segundo le o estado ja escrito e o caso passa sem o compare-and-swap ter
 * participado (medido no Bloco 8c: CASO 22 detectava a remocao do CAS em 1/4).
 *
 * Uma transacao externa segura o lock da linha; cada disputante le o pagamento
 * (SELECT nao bloqueia), faz o que faz antes de escrever — inclusive chamar o
 * provedor — e TRAVA no `updateMany`. Em READ COMMITTED o Postgres reavalia o
 * WHERE de cada UPDATE bloqueado contra a versao nova quando o lock solta:
 * todos leram o MESMO estado, entao so o CAS pode recusa-los.
 *
 * FOR NO KEY UPDATE, nao FOR UPDATE: um INSERT com chave estrangeira para
 * `payments` (o registro de idempotencia do reembolso, a trilha de transacao)
 * toma KEY SHARE, que FOR UPDATE bloquearia — os disputantes parariam cedo
 * demais, no insert, e correriam de novo depois. NO KEY UPDATE deixa o insert
 * passar e bloqueia exatamente o `UPDATE` de coluna nao-chave do CAS.
 *
 * A barreira e OBSERVADA em `pg_stat_activity`; o chamador asserta
 * `bloqueados === N` para que um ambiente sem sobreposicao falhe alto.
 * Recebe o client por parametro: nesta suite ele nasce em `connectDatabase`.
 */
export async function disputarComLinhaTravada<T>(
  prisma: PrismaClient,
  paymentId: string,
  // Fabricas, nao promises: criar a promise E iniciar o trabalho, e a ORDEM de
  // inicio decide quem vence. A fila de lock do Postgres e FIFO: o disputante
  // i entra na fila antes do i+1, entao adquire primeiro. Cada um so e
  // disparado depois de o anterior estar ESPERANDO — vencedor previsivel, nao
  // sorteado. Importa quando outra condicao do mesmo WHERE depende de quem
  // vence (CASO 44: a ordenacao por providerCreatedAt mascarava a remocao do
  // CAS de status sempre que o evento novo vencia — medido 3/4).
  disputantes: Array<() => Promise<T>>,
  opcoes: { timeoutMs?: number } = {},
): Promise<ResultadoDaDisputa<T>> {
  const timeoutMs = opcoes.timeoutMs ?? 3_000;
  let emVoo!: Promise<PromiseSettledResult<T>[]>;
  let bloqueados = 0;

  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR NO KEY UPDATE`;
      const promessas: Promise<T>[] = [];
      for (const iniciar of disputantes) {
        // Promise.resolve: um thenable PREGUICOSO (o Test do supertest so envia
        // a requisicao quando alguem chama .then) precisa ser acordado AGORA,
        // senao a barreira espera por um disputante que nunca saiu do lugar.
        promessas.push(Promise.resolve(iniciar()));
        bloqueados = await esperarBloqueados(prisma, promessas.length, timeoutMs);
      }
      emVoo = Promise.allSettled(promessas);
    },
    { timeout: timeoutMs * disputantes.length + 5_000 },
  );

  return { resultados: await emVoo, bloqueados };
}

async function esperarBloqueados(prisma: PrismaClient, n: number, timeoutMs: number): Promise<number> {
  const limite = Date.now() + timeoutMs;
  let visto = 0;
  while (Date.now() < limite) {
    const linhas = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    visto = linhas[0]?.n ?? 0;
    if (visto >= n) return visto;
    await new Promise((r) => setTimeout(r, 20));
  }
  return visto;
}
