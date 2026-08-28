import { tickReconciliacao, type ReconciliacaoDeps } from './reconciliacao';

function inteiroNaFaixa(raw: string | undefined, padrao: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}

/**
 * Intervalo MUITO maior que o do relay, de proposito.
 *
 * O relay corre atras de eventos que devem sair rapido. A reconciliacao corre
 * atras de tentativas que ja esperaram a janela inteira — varrer a cada segundo
 * so produziria consulta ao banco e chamada ao provedor sem ganho nenhum, e
 * chamada ao provedor tem custo real e limite de taxa.
 */
const POLL_INTERVAL_MS = inteiroNaFaixa(process.env.RECONCILIACAO_POLL_INTERVAL_MS, 60_000, 1_000, 3_600_000);
const STOP_TIMEOUT_MS = inteiroNaFaixa(process.env.RECONCILIACAO_STOP_TIMEOUT_MS, 5_000, 1, 60_000);

let timer: NodeJS.Timeout | null = null;
let cicloAtual: Promise<unknown> | null = null;
let iniciado = false;
let parado = false;

export function startReconciliacao(deps: ReconciliacaoDeps): void {
  if (iniciado) return;
  iniciado = true;
  parado = false;

  const loop = async (): Promise<void> => {
    if (parado) return;
    // Falha do ciclo INTEIRO (banco fora, por exemplo) nao pode matar o laco:
    // sem este catch, uma rejeicao aqui derruba o processo e a reconciliacao
    // para de existir ate alguem reiniciar o servico.
    cicloAtual = tickReconciliacao(deps).catch((erro: unknown) => {
      console.error(
        '[reconciliacao] ciclo falhou: ' + (erro instanceof Error ? erro.message : String(erro)),
      );
    });
    await cicloAtual;
    cicloAtual = null;
    if (!parado) timer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
  };

  console.log('[reconciliacao] job iniciado (intervalo ' + POLL_INTERVAL_MS + 'ms)');
  void loop();
}

/**
 * Para e AGUARDA o ciclo em voo, com teto. Cortar no meio de uma aplicacao de
 * desfecho nao perde dinheiro — o CAS garante que so uma execucao aplica —, mas
 * deixaria a tentativa presa por mais um intervalo sem necessidade.
 */
export async function stopReconciliacao(): Promise<void> {
  parado = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (cicloAtual) {
    let idDoTeto: NodeJS.Timeout | undefined;
    const teto = new Promise<void>((resolve) => {
      idDoTeto = setTimeout(() => {
        console.warn(
          '[reconciliacao] ciclo nao terminou em ' + STOP_TIMEOUT_MS + 'ms; seguindo o shutdown',
        );
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
