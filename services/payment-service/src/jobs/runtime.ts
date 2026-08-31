/** Uma varredura periodica. O nome existe para o log dizer QUAL delas falhou. */
export interface Varredura {
  nome: string;
  executar: () => Promise<unknown>;
}

export interface OpcoesDosJobs {
  pollIntervalMs: number;
  stopTimeoutMs: number;
  /** Prazo de UMA varredura. Ver `comPrazo`. */
  varreduraTimeoutMs: number;
}

/** Distingue "estourou o prazo" de "falhou" — o tratamento e diferente. */
class PrazoExcedido extends Error {}

function motivo(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

let timer: NodeJS.Timeout | null = null;
let cicloAtual: Promise<unknown> | null = null;
let executorAtual: ExecutorDeCiclo | null = null;
let iniciado = false;
let parado = false;
let tetoDeParada = 5_000;

/**
 * Prazo para uma promessa.
 *
 * NAO cancela o trabalho subjacente — cancelamento real exigiria AbortSignal
 * propagado ate o driver do banco e o cliente do provedor. O objetivo aqui e
 * devolver o controle ao LACO: sem prazo, uma varredura que nunca resolve (e
 * por isso nunca rejeita, entao nenhum catch a pega) segura o `await` do ciclo,
 * o proximo timer jamais e agendado, e TODAS as varreduras param.
 *
 * Como o trabalho continua vivo, quem chama e obrigado a nao perde-lo de vista.
 * Ver `criarExecutorDeCiclo`.
 */
async function comPrazo<T>(promessa: Promise<T>, ms: number, nome: string): Promise<T> {
  let id: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promessa,
      new Promise<never>((_, rejeitar) => {
        id = setTimeout(() => rejeitar(new PrazoExcedido(`excedeu o prazo de ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (id) clearTimeout(id);
  }
}

export interface ExecutorDeCiclo {
  executar: (parouDeRodar: () => boolean) => Promise<void>;
  /** Trabalhos que excederam o prazo e continuam vivos. Usado pelo shutdown. */
  emVoo: () => Promise<unknown>[];
}

/**
 * Executor com SINGLE-FLIGHT por varredura.
 *
 * Corrige uma regressao introduzida pela propria correcao anterior (achado 4.1
 * da 3a rodada de review do PR #58): o prazo devolvia o laco, mas abandonava a
 * operacao. A original seguia viva, o ciclo seguinte iniciava OUTRA, e elas se
 * acumulavam — conexoes, chamadas ao provedor e execucoes concorrentes da mesma
 * varredura. Trocar travamento por vazamento nao e conserto.
 *
 * Agora, enquanto um trabalho nao assentar, a varredura dele e PULADA nos
 * ciclos seguintes, e a promessa continua rastreada para o shutdown poder
 * espera-la em vez de encerrar banco e relay por cima dela.
 *
 * O estado vive em FECHAMENTO, nao em modulo: dois executores no mesmo processo
 * nao se contaminam, e o teste nao precisa de `jest.resetModules()`.
 */
export function criarExecutorDeCiclo(varreduras: Varredura[], prazoMs: number): ExecutorDeCiclo {
  const emVoo = new Map<string, Promise<unknown>>();

  return {
    emVoo: () => Array.from(emVoo.values()),

    executar: async (parouDeRodar: () => boolean): Promise<void> => {
      for (const varredura of varreduras) {
        if (parouDeRodar()) return;

        if (emVoo.has(varredura.nome)) {
          console.warn(
            '[jobs] varredura ' + varredura.nome + ' ainda em voo do ciclo anterior; pulando',
          );
          continue;
        }

        const estado = { expirou: false };
        const trabalho = varredura.executar();
        emVoo.set(varredura.nome, trabalho);

        void trabalho.then(
          () => {
            emVoo.delete(varredura.nome);
          },
          (erro: unknown) => {
            emVoo.delete(varredura.nome);
            // Rejeicao que chega DEPOIS do prazo nao tem mais ninguem
            // esperando: sem este tratador ela viraria unhandled rejection e
            // sumiria do log — justamente o caso que mais precisa aparecer.
            if (estado.expirou) {
              console.error(
                '[jobs] varredura ' + varredura.nome + ' rejeitou APOS o prazo: ' + motivo(erro),
              );
            }
          },
        );

        try {
          await comPrazo(trabalho, prazoMs, varredura.nome);
        } catch (erro) {
          if (erro instanceof PrazoExcedido) estado.expirou = true;
          // CATCH POR VARREDURA, nao ao redor do ciclo: com um catch so, uma
          // falha na reconciliacao deixaria o inbox sem varrer ate alguem
          // reiniciar o servico — e vice-versa. As duas sao independentes.
          console.error('[jobs] varredura ' + varredura.nome + ' falhou: ' + motivo(erro));
        }
      }
    },
  };
}

/**
 * Um timer para TODAS as varreduras de manutencao (Bloco 6c).
 *
 * Antes isto rodava so a reconciliacao. A alternativa ao generalizar seria um
 * segundo runtime para o inbox — o que duplicaria start, stop com teto e guarda
 * de parada, codigo que JA e divida por nao ter teste de ciclo de vida.
 *
 * Os intervalos vem do AppConfig, e nao de process.env lido no import: eles
 * participam do invariante entre janela, quarentena e ciclo (achado 4.2).
 */
export function startJobs(varreduras: Varredura[], opcoes: OpcoesDosJobs): void {
  if (iniciado) return;
  iniciado = true;
  parado = false;
  tetoDeParada = opcoes.stopTimeoutMs;

  const executor = criarExecutorDeCiclo(varreduras, opcoes.varreduraTimeoutMs);
  executorAtual = executor;

  const loop = async (): Promise<void> => {
    if (parado) return;
    cicloAtual = executor.executar(() => parado);
    await cicloAtual;
    cicloAtual = null;
    if (!parado) timer = setTimeout(() => void loop(), opcoes.pollIntervalMs);
  };

  console.log(
    '[jobs] ' +
      String(varreduras.length) +
      ' varredura(s), intervalo ' +
      String(opcoes.pollIntervalMs) +
      'ms, prazo ' +
      String(opcoes.varreduraTimeoutMs) +
      'ms',
  );
  void loop();
}

/**
 * Para e AGUARDA o ciclo em voo, com teto.
 *
 * Espera tambem os trabalhos que EXCEDERAM o prazo e continuam vivos: sem isso,
 * o shutdown fecharia banco e publisher por cima de uma varredura ainda em
 * execucao (achado 4.1 da 3a rodada). O teto continua valendo — a garantia e
 * "nao encerra por cima sem esperar", nao "espera para sempre".
 */
export async function stopJobs(): Promise<void> {
  parado = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const pendentes: Promise<unknown>[] = [];
  if (cicloAtual) pendentes.push(cicloAtual);
  if (executorAtual) pendentes.push(...executorAtual.emVoo());

  if (pendentes.length > 0) {
    let idDoTeto: NodeJS.Timeout | undefined;
    const teto = new Promise<void>((resolve) => {
      idDoTeto = setTimeout(() => {
        console.warn('[jobs] ciclo nao terminou em ' + tetoDeParada + 'ms; seguindo o shutdown');
        resolve();
      }, tetoDeParada);
    });
    try {
      await Promise.race([
        Promise.all(pendentes.map((p) => p.catch(() => undefined))).then(() => undefined),
        teto,
      ]);
    } finally {
      if (idDoTeto) clearTimeout(idDoTeto);
    }
  }

  executorAtual = null;
  iniciado = false;
}
