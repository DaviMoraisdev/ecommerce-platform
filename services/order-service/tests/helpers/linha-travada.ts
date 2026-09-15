import { prisma } from '../../src/config/database';

export interface ResultadoDaDisputa<T> {
  resultados: PromiseSettledResult<T>[];
  /** Disputantes que o Postgres viu ESPERANDO lock antes de ele ser solto. */
  bloqueados: number;
}

/**
 * Forca a sobreposicao de N disputantes sobre a MESMA linha de `orders`.
 *
 * Problema que resolve: `Promise.all` nao e teste de concorrencia. Quando as
 * chamadas serializam, a matriz de transicao recusa as perdedoras e o caso
 * passa SEM o compare-and-swap ter participado (medido: 1/4 e 2/4 de deteccao
 * sob a sabotagem S2). Tempo fixo (`sleep`) troca sorte por outra sorte.
 *
 * Mecanismo: uma transacao externa segura o lock da linha (FOR UPDATE). Cada
 * disputante le o pedido (SELECT nao bloqueia), passa pela matriz e TRAVA no
 * `updateMany`. Em READ COMMITTED o Postgres reavalia o WHERE de cada UPDATE
 * bloqueado contra a versao nova da linha quando o lock solta: o primeiro casa,
 * os outros veem o status novo e casam 0 linhas. Todos leram o MESMO estado
 * antes de qualquer escrita, entao so o CAS pode recusa-los — sem CAS, todos
 * escrevem.
 *
 * A barreira e OBSERVADA, nao presumida: `pg_stat_activity` diz quantos
 * backends esperam lock. O chamador asserta `bloqueados === N`; se o ambiente
 * nao produziu a sobreposicao, o caso falha dizendo isso em vez de passar
 * medindo a matriz.
 *
 * Custo em conexoes: N disputantes + 1 (lock) + 1 (polling). Pool default do
 * Prisma e `cpus * 2 + 1`; com N = 5 cabe em runner de 2 cores (pool 5) NAO
 * caberia — o CI atual tem 4 (pool 9). Registrado.
 */
export async function disputarComLinhaTravada<T>(
  orderId: string,
  // Fabricas, nao promises: criar a promise E iniciar o trabalho, e a ordem de
  // inicio decide quem vence — a fila de lock do Postgres e FIFO. Cada
  // disputante so e disparado depois de o anterior estar ESPERANDO, entao o
  // vencedor e o primeiro da lista, nao um sorteio. (Ver o CASO 44 do
  // payment-service, onde o sorteio mascarava a sabotagem em metade das vezes.)
  disputantes: Array<() => Promise<T>>,
  opcoes: { timeoutMs?: number } = {},
): Promise<ResultadoDaDisputa<T>> {
  const timeoutMs = opcoes.timeoutMs ?? 3_000;
  let emVoo!: Promise<PromiseSettledResult<T>[]>;
  let bloqueados = 0;

  await prisma.$transaction(
    async (tx) => {
      // Parametrizado pelo tagged template: nunca interpolar o id na string.
      // FOR NO KEY UPDATE, nao FOR UPDATE: um INSERT com FK para `orders` (o
      // inbox, o historico) toma KEY SHARE, que FOR UPDATE bloquearia — os
      // disputantes parariam no insert, cedo demais, e correriam de novo. NO
      // KEY UPDATE deixa o insert passar e bloqueia exatamente o UPDATE de
      // coluna nao-chave do CAS.
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR NO KEY UPDATE`;
      const promessas: Promise<T>[] = [];
      // Prazo TOTAL, nao por disputante: com prazo por disputante o pior caso e
      // timeoutMs * N, que estoura o timeout do Jest e deixa o lock vivo depois
      // de o caso ter sido abandonado — envenenando os casos seguintes (visto
      // no CI). Aqui a barreira falha alto DENTRO do prazo, e o lock morre junto.
      const prazo = Date.now() + timeoutMs;
      for (const iniciar of disputantes) {
        // Promise.resolve acorda thenables preguicosos (supertest).
        promessas.push(Promise.resolve(iniciar()));
        bloqueados = await esperarBloqueados(promessas.length, prazo);
      }
      emVoo = Promise.allSettled(promessas);
    },
    // Acima do teto da barreira: o default (5 s) abortaria a transacao do lock
    // no mesmo instante em que a espera desiste, mascarando o motivo real.
    { timeout: timeoutMs + 2_000 },
  );

  return { resultados: await emVoo, bloqueados };
}

async function esperarBloqueados(n: number, limite: number): Promise<number> {
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
