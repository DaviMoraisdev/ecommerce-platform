import type { ChargeResult, ChargeSnapshot } from '../providers/payment-provider.port';

/**
 * O que fazer com uma tentativa presa, dado o que o PROVEDOR diz.
 *
 * Uniao discriminada: cada variante carrega so o que a sua aplicacao precisa,
 * e combinacao impossivel nao compila.
 */
export type AcaoDeReconciliacao =
  /** O provedor nunca recebeu. Nada de dinheiro se moveu; libera para nova tentativa. */
  | { tipo: 'liberar' }
  /** Ha desfecho: aplica pelo MESMO caminho do fluxo normal. */
  | { tipo: 'aplicar'; resultado: ChargeResult }
  /** O provedor ainda nao decidiu. O webhook resolve; nao tocar em nada. */
  | { tipo: 'aguardar' }
  /** Estado que o job nao sabe aplicar com seguranca. Nao toca, e sinaliza. */
  | { tipo: 'triagem'; motivo: string };

/**
 * Traduz o que o provedor diz AGORA no que o fluxo normal sabe aplicar.
 *
 * Funcao PURA: sem banco, sem provedor, sem relogio. E o que torna os casos
 * R1-R6 testaveis sem infraestrutura nenhuma.
 *
 * A assimetria que organiza tudo: aplicar desfecho errado mexe em dinheiro e e
 * irreversivel do ponto de vista do cliente; NAO aplicar deixa a tentativa
 * presa, o que ja e o estado atual e continua visivel. Na duvida, nao aplica.
 */
export function decidirReconciliacao(
  snapshot: ChargeSnapshot | null,
  ausenciaEDefinitiva: boolean,
): AcaoDeReconciliacao {
  // Ausencia e a unica evidencia que autoriza refazer a tentativa: a chamada
  // nunca chegou, entao attemptCount + 1 (e chave de provedor nova) nao pode
  // duplicar cobranca. Mas isso so vale se a ausencia for DEFINITIVA: num
  // provedor eventualmente consistente, `null` tambem significa "cobrou e ainda
  // nao aparece", e liberar ali produz a segunda cobranca. Sem a garantia, a
  // ausencia vira triagem — preso e visivel e melhor que liberado no escuro.
  if (snapshot === null) {
    if (!ausenciaEDefinitiva) {
      return { tipo: 'triagem', motivo: 'cobranca ausente e provedor sem garantia de ausencia definitiva' };
    }
    return { tipo: 'liberar' };
  }

  switch (snapshot.state) {
    case 'SUCCEEDED':
      return {
        tipo: 'aplicar',
        resultado: {
          providerRef: snapshot.providerRef,
          state: 'SUCCEEDED',
          capturedAmountCents: snapshot.capturedAmountCents,
        },
      };

    case 'DECLINED':
      // declineCode e OPCIONAL no snapshot e OBRIGATORIO no ChargeResult.
      // Preencher com um valor de fachada gravaria uma mentira na resposta
      // congelada, devolvida ao cliente em todo replay, para sempre — e
      // parecendo um codigo do provedor. Preso e visivel e melhor que liberado
      // com dado inventado.
      if (snapshot.declineCode === undefined) {
        return { tipo: 'triagem', motivo: 'recusa sem declineCode' };
      }
      return {
        tipo: 'aplicar',
        resultado: {
          providerRef: snapshot.providerRef,
          state: 'DECLINED',
          capturedAmountCents: 0,
          declineCode: snapshot.declineCode,
        },
      };

    case 'PROCESSING':
      // O provedor ainda nao decidiu. Aplicar aqui seria inventar desfecho.
      return { tipo: 'aguardar' };

    case 'CANCELED':
      // ChargeSnapshot admite CANCELED; ChargeResult nao — e o compilador
      // impede a traducao. Aplicar cancelamento e o outro item do Bloco 6
      // (expiracao da janela, com cancelCharge), e misturar os dois repetiria
      // o problema de escopo que alongou o 5b.
      return { tipo: 'triagem', motivo: 'cobranca cancelada no provedor' };
  }
}

/** Uma tentativa presa, com o minimo que a varredura precisa saber. */
export interface TentativaPresa {
  id: string;
  paymentId: string;
  attemptCount: number;
  /** Compoe o cursor da paginacao junto com o `id`. */
  createdAt: Date;
}

/** Ultima linha ja examinada neste ciclo. Ver a nota de keyset no repositorio. */
export interface CursorDaVarredura {
  createdAt: Date;
  id: string;
}

export interface ReconciliacaoDeps {
  /** Tentativas PENDING sem providerRef, criadas ANTES do limite e APOS o cursor. */
  buscarPresas: (limite: Date, lote: number, apos?: CursorDaVarredura) => Promise<TentativaPresa[]>;
  consultarProvedor: (paymentId: string, attemptCount: number) => Promise<ChargeSnapshot | null>;
  aplicar: (transactionId: string, resultado: ChargeResult) => Promise<boolean>;
  liberar: (transactionId: string) => Promise<boolean>;
  /** Ver `PaymentProvider.ausenciaEDefinitiva`. Sem default: escolher em silencio e o risco. */
  ausenciaEDefinitiva: boolean;
  agora?: () => Date;
  janelaMinutos?: number;
  lote?: number;
  maxLotes?: number;
}

export interface ResumoDaVarredura {
  examinadas: number;
  aplicadas: number;
  liberadas: number;
  aguardando: number;
  triagem: number;
  falhas: number;
  /** true = o ciclo parou no teto de lotes, SEM provar que a fila acabou. */
  truncada: boolean;
}

function inteiroNaFaixa(valor: number | undefined, padrao: number, min: number, max: number): number {
  return valor !== undefined && Number.isInteger(valor) && valor >= min && valor <= max
    ? valor
    : padrao;
}

/**
 * Um ciclo da varredura.
 *
 * NAO escreve no banco de pagamento: pergunta ao provedor, decide, e delega a
 * aplicacao a quem e dono dos invariantes. O job e uma varredura com um relogio.
 *
 * PROGRESSO GARANTIDO: `aguardar`, `triagem` e falha NAO alteram a linha, entao
 * ela continua candidata e continua entre as mais antigas. Sem paginar, um lote
 * de itens nao-acionaveis congelaria a varredura e nenhuma tentativa posterior
 * seria examinada — bastava o provedor ficar fora do ar durante um ciclo. O
 * ciclo agora avanca pelo cursor ate esgotar a fila ou atingir `maxLotes`.
 * LIMITE RESIDUAL: com mais itens travados que `maxLotes * lote`, o problema
 * volta; a correcao definitiva e estado duravel de triagem (registrado em
 * TECH_DEBT.md), que exige migracao.
 */
export async function tickReconciliacao(deps: ReconciliacaoDeps): Promise<ResumoDaVarredura> {
  const agora = deps.agora ? deps.agora() : new Date();
  const janela = inteiroNaFaixa(deps.janelaMinutos, 15, 1, 1440);
  const lote = inteiroNaFaixa(deps.lote, 20, 1, 500);
  const maxLotes = inteiroNaFaixa(deps.maxLotes, 5, 1, 100);

  // A janela nao e otimizacao, e correcao: sem ela o job pegaria uma tentativa
  // cuja chamada ao provedor ainda esta em voo e aplicaria desfecho por baixo
  // dela — competindo com a propria requisicao que a criou.
  const limite = new Date(agora.getTime() - janela * 60_000);

  const resumo: ResumoDaVarredura = {
    examinadas: 0,
    aplicadas: 0,
    liberadas: 0,
    aguardando: 0,
    triagem: 0,
    falhas: 0,
    truncada: false,
  };

  let cursor: CursorDaVarredura | undefined;

  for (let pagina = 0; pagina < maxLotes; pagina += 1) {
    const presas = await deps.buscarPresas(limite, lote, cursor);
    if (presas.length === 0) return resumo;

    resumo.examinadas += presas.length;

    for (const presa of presas) {
      try {
        const snapshot = await deps.consultarProvedor(presa.paymentId, presa.attemptCount);
        const acao = decidirReconciliacao(snapshot, deps.ausenciaEDefinitiva);

        switch (acao.tipo) {
          case 'liberar':
            if (await deps.liberar(presa.id)) resumo.liberadas += 1;
            break;
          case 'aplicar':
            // false = outra execucao ganhou o CAS. Contar como aplicada inflaria
            // a metrica e esconderia que este ciclo nao fez nada.
            if (await deps.aplicar(presa.id, acao.resultado)) resumo.aplicadas += 1;
            break;
          case 'aguardar':
            resumo.aguardando += 1;
            break;
          case 'triagem':
            resumo.triagem += 1;
            console.warn(
              '[payment-service] reconciliacao exige triagem: tentativa ' +
                presa.id +
                ' — ' +
                acao.motivo,
            );
            break;
        }
      } catch (erro) {
        // Falha de UM item nao aborta o lote. Abortar deixaria todas as outras
        // presas por causa de uma, e a proxima execucao repetiria o mesmo item
        // primeiro — bloqueio de cabeca de fila, num ciclo que nunca avanca.
        resumo.falhas += 1;
        console.error(
          '[payment-service] falha ao reconciliar a tentativa ' +
            presa.id +
            ': ' +
            (erro instanceof Error ? erro.message : String(erro)),
        );
      }
    }

    // Pagina incompleta significa fim da fila: nao ha proxima.
    if (presas.length < lote) return resumo;

    // `.at(-1)` nao compila com o `lib` atual do tsconfig (divida registrada).
    const ultima = presas[presas.length - 1];
    cursor = { createdAt: ultima.createdAt, id: ultima.id };
  }

  resumo.truncada = true;
  console.warn(
    '[payment-service] reconciliacao parou no teto de ' +
      maxLotes +
      ' lotes por ciclo, sem provar que a fila acabou',
  );
  return resumo;
}
