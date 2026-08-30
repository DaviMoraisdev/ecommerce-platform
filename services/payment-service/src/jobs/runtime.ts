function inteiroNaFaixa(raw: string | undefined, padrao: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}

/**
 * Intervalo MUITO maior que o do relay, de proposito.
 *
 * O relay corre atras de eventos que devem sair rapido. Estas varreduras correm
 * atras de coisas que ja esperaram a janela inteira — varrer a cada segundo so
 * produziria consulta ao banco e chamada ao provedor sem ganho nenhum, e
 * chamada ao provedor tem custo real e limite de taxa.
 *
 * Os NOMES das variaveis continuam RECONCILIACAO_* de proposito: renomear
 * quebraria .env em uso para ganhar so estetica.
 */
const POLL_INTERVAL_MS = inteiroNaFaixa(process.env.RECONCILIACAO_POLL_INTERVAL_MS, 60_000, 1_000, 3_600_000);
const STOP_TIMEOUT_MS = inteiroNaFaixa(process.env.RECONCILIACAO_STOP_TIMEOUT_MS, 5_000, 1, 60_000);

/** Uma varredura periodica. O nome existe para o log dizer QUAL delas falhou. */
export interface Varredura {
  nome: string;
  executar: () => Promise<unknown>;
}

let timer: NodeJS.Timeout | null = null;
let cicloAtual: Promise<unknown> | null = null;
let iniciado = false;
let parado = false;

/**
 * Um timer para TODAS as varreduras de manutencao (Bloco 6c).
 *
 * Antes isto rodava so a reconciliacao. A alternativa ao generalizar seria um
 * segundo runtime para o inbox — o que duplicaria start, stop com teto e guarda
 * de parada, codigo que JA e divida por nao ter teste de ciclo de vida.
 * Duplicar codigo nao testado e pior que generaliza-lo.
 */
export function startJobs(varreduras: Varredura[]): void {
  if (iniciado) return;
  iniciado = true;
  parado = false;

  const ciclo = async (): Promise<void> => {
    for (const varredura of varreduras) {
      if (parado) return;
      try {
        await varredura.executar();
      } catch (erro) {
        // CATCH POR VARREDURA, nao ao redor do ciclo: com um catch so, uma
        // falha na reconciliacao deixaria o inbox sem varrer ate alguem
        // reiniciar o servico — e vice-versa. Sao independentes.
        console.error(
          '[jobs] varredura ' +
            varredura.nome +
            ' falhou: ' +
            (erro instanceof Error ? erro.message : String(erro)),
        );
      }
    }
  };

  const loop = async (): Promise<void> => {
    if (parado) return;
    cicloAtual = ciclo();
    await cicloAtual;
    cicloAtual = null;
    if (!parado) timer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
  };

  console.log(
    '[jobs] ' + String(varreduras.length) + ' varredura(s), intervalo ' + POLL_INTERVAL_MS + 'ms',
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
        console.warn('[jobs] ciclo nao terminou em ' + STOP_TIMEOUT_MS + 'ms; seguindo o shutdown');
        resolve();
      }, STOP_TIMEOUT_MS);
    });
    try {
      await Promise.race([cicloAtual.catch(() => undefined), teto]);
    } finally {
      if (idDoTeto) clearTimeout(idDoTeto);
    }
  }
  iniciado = false;
}
