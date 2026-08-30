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

let timer: NodeJS.Timeout | null = null;
let cicloAtual: Promise<unknown> | null = null;
let iniciado = false;
let parado = false;
let tetoDeParada = 5_000;

/**
 * Prazo para uma promessa.
 *
 * NAO cancela o trabalho subjacente — uma consulta pendente no driver continua
 * pendente. O objetivo e outro: devolver o controle ao LACO. Sem isto, uma
 * varredura que nunca resolve (e por isso nunca rejeita, entao nenhum catch a
 * pega) segura o `await` do ciclo, o proximo timer jamais e agendado, e TODAS
 * as varreduras param — inclusive as saudaveis. Achado 4.3 da 2a rodada de
 * review do PR #58.
 */
async function comPrazo<T>(promessa: Promise<T>, ms: number, nome: string): Promise<T> {
  let id: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promessa,
      new Promise<never>((_, rejeitar) => {
        id = setTimeout(() => rejeitar(new Error(`excedeu o prazo de ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (id) clearTimeout(id);
  }
}

/**
 * Um ciclo: roda cada varredura em ordem, isolando falhas E lentidao.
 *
 * Exportada e sem timer de proposito. O ciclo de vida do job (timers, teto do
 * stop) e divida registrada por nao ter teste; este mecanismo e NOVO e nao
 * precisa herdar essa lacuna — como funcao de efeito com prazo explicito, ele
 * se testa sem relogio falso.
 */
export async function executarCiclo(
  varreduras: Varredura[],
  parouDeRodar: () => boolean,
  prazoMs: number,
): Promise<void> {
  for (const varredura of varreduras) {
    if (parouDeRodar()) return;
    try {
      await comPrazo(varredura.executar(), prazoMs, varredura.nome);
    } catch (erro) {
      // CATCH POR VARREDURA, nao ao redor do ciclo: com um catch so, uma falha
      // na reconciliacao deixaria o inbox sem varrer ate alguem reiniciar o
      // servico — e vice-versa. As duas sao independentes.
      console.error(
        '[jobs] varredura ' +
          varredura.nome +
          ' falhou: ' +
          (erro instanceof Error ? erro.message : String(erro)),
      );
    }
  }
}

/**
 * Um timer para TODAS as varreduras de manutencao (Bloco 6c).
 *
 * Antes isto rodava so a reconciliacao. A alternativa ao generalizar seria um
 * segundo runtime para o inbox — o que duplicaria start, stop com teto e guarda
 * de parada, codigo que JA e divida por nao ter teste de ciclo de vida.
 * Duplicar codigo nao testado e pior que generaliza-lo.
 *
 * Os intervalos vem do AppConfig, e nao de process.env lido no import: eles
 * participam do invariante entre janela, quarentena e poll (achado 4.2), e
 * validacao central exige valor central.
 */
export function startJobs(varreduras: Varredura[], opcoes: OpcoesDosJobs): void {
  if (iniciado) return;
  iniciado = true;
  parado = false;
  tetoDeParada = opcoes.stopTimeoutMs;

  const loop = async (): Promise<void> => {
    if (parado) return;
    cicloAtual = executarCiclo(varreduras, () => parado, opcoes.varreduraTimeoutMs);
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
 * Para e AGUARDA o ciclo em voo, com teto. Cortar no meio de uma aplicacao de
 * desfecho nao perde dinheiro — o CAS garante que so uma execucao aplica —, mas
 * deixaria a tentativa presa por mais um intervalo sem necessidade.
 */
export async function stopJobs(): Promise<void> {
  parado = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (cicloAtual) {
    let idDoTeto: NodeJS.Timeout | undefined;
    const teto = new Promise<void>((resolve) => {
      idDoTeto = setTimeout(() => {
        console.warn('[jobs] ciclo nao terminou em ' + tetoDeParada + 'ms; seguindo o shutdown');
        resolve();
      }, tetoDeParada);
    });
    try {
      await Promise.race([cicloAtual.catch(() => undefined), teto]);
    } finally {
      if (idDoTeto) clearTimeout(idDoTeto);
    }
  }
  iniciado = false;
}
