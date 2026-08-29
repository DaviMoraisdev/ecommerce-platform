/**
 * Encerramento gracioso.
 *
 * Sem isto, um SIGTERM mata o processo no meio de uma requisicao e deixa a
 * conexao do Prisma pendurada. Em desenvolvimento o `ts-node-dev` respawn faz
 * isso a cada salvamento; com endpoint de pagamento, encerrar no meio de uma
 * cobranca tem consequencia real.
 *
 * A logica esta em funcao com dependencias injetadas para que a ORDEM (fechar o
 * servidor antes de desconectar o banco) e os caminhos de falha sejam
 * verificaveis sem subir servidor nem banco.
 */

export interface EncerramentoDeps {
  /** Para de aceitar conexoes e espera as em voo terminarem. */
  fecharServidor: () => Promise<void>;
  /**
   * ANTES do relay: a reconciliacao PRODUZ eventos na outbox (a captura
   * descoberta vira payment.captured). Parar o produtor primeiro deixa o relay
   * drenar o que acabou de ser gravado, em vez de empurrar para o proximo boot.
   */
  pararReconciliacao: () => Promise<void>;
  /** Aguarda o ciclo em voo do relay: cortar no meio deixaria evento a caminho. */
  pararRelay: () => Promise<void>;
  /** So depois do relay parado, senao a conexao cai no meio de uma publicacao. */
  fecharPublisher: () => Promise<void>;
  desconectarBanco: () => Promise<void>;
  /** Teto para o encerramento inteiro. */
  timeoutMs?: number;
  log?: (mensagem: string) => void;
  reportarErro?: (mensagem: string) => void;
}

const TIMEOUT_PADRAO_MS = 10_000;

/**
 * Devolve o codigo de saida e NUNCA lanca: quem chama esta a caminho de
 * `process.exit`, e uma excecao ali viraria um encerramento pior que o problema.
 */
export async function encerrar(deps: EncerramentoDeps): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const reportarErro = deps.reportarErro ?? ((m: string) => console.error(m));
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_PADRAO_MS;

  log('[payment-service] encerrando...');

  let codigo = 0;
  let temporizador: NodeJS.Timeout | undefined;

  const estouro = new Promise<'timeout'>((resolve) => {
    temporizador = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const sequencia = (async (): Promise<'ok'> => {
    // Fecha o servidor PRIMEIRO: desconectar o banco antes deixaria requisicoes
    // em voo sem persistencia, transformando encerramento em erro 500.
    try {
      await deps.fecharServidor();
      log('[payment-service] servidor fechado');
    } catch (erro) {
      reportarErro(
        '[payment-service] falha ao fechar o servidor: ' + (erro as Error).message,
      );
      codigo = 1;
    }

    // Relay ANTES do publisher: na ordem inversa, a conexao cairia no meio de
    // uma publicacao ja iniciada.
    try {
      // ANTES do relay: a reconciliacao PRODUZ eventos na outbox. Parar o
      // produtor primeiro deixa o relay drenar o que acabou de ser gravado.
      await deps.pararReconciliacao();
      await deps.pararRelay();
      log('[payment-service] relay da outbox parado');
    } catch (erro) {
      reportarErro(
        '[payment-service] falha ao parar o relay: ' + (erro as Error).message,
      );
      codigo = 1;
    }

    try {
      await deps.fecharPublisher();
      log('[payment-service] publisher fechado');
    } catch (erro) {
      reportarErro(
        '[payment-service] falha ao fechar o publisher: ' + (erro as Error).message,
      );
      codigo = 1;
    }

    // Best effort: desconecta mesmo se o fechamento falhou, para nao deixar a
    // conexao pendurada por causa de um erro anterior.
    try {
      await deps.desconectarBanco();
      log('[payment-service] banco desconectado');
    } catch (erro) {
      reportarErro(
        '[payment-service] falha ao desconectar do banco: ' + (erro as Error).message,
      );
      codigo = 1;
    }

    return 'ok';
  })();

  const resultado = await Promise.race([sequencia, estouro]);
  if (temporizador) clearTimeout(temporizador);

  if (resultado === 'timeout') {
    reportarErro(
      `[payment-service] encerramento excedeu ${timeoutMs}ms — saindo de forma abrupta`,
    );
    return 1;
  }

  return codigo;
}

export interface RegistroDeSinaisDeps extends EncerramentoDeps {
  /** Injetavel para teste. */
  onSinal?: (sinal: NodeJS.Signals, handler: () => void) => void;
  sair?: (codigo: number) => void;
  sinais?: readonly NodeJS.Signals[];
}

const SINAIS_PADRAO = ['SIGTERM', 'SIGINT'] as const;

/**
 * Liga os sinais ao encerramento. Um segundo sinal e IGNORADO: dois Ctrl+C
 * disparariam duas sequencias concorrentes, e a segunda encontraria o servidor
 * ja fechado.
 */
export function registrarEncerramento(deps: RegistroDeSinaisDeps): void {
  const onSinal =
    deps.onSinal ?? ((sinal, handler) => void process.on(sinal, handler));
  const sair = deps.sair ?? ((codigo: number) => process.exit(codigo));
  const sinais = deps.sinais ?? SINAIS_PADRAO;

  let encerrando = false;

  for (const sinal of sinais) {
    onSinal(sinal, () => {
      if (encerrando) return;
      encerrando = true;
      void encerrar(deps).then(sair);
    });
  }
}
