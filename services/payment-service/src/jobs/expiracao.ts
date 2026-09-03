import {
  ChargeNotCancelableError,
  type ChargeResult,
  type ChargeSnapshot,
} from '../providers/payment-provider.port';
import type { CursorDaVarredura } from './keyset';
import { mensagemSegura } from '../domain/mensagem-segura';

/**
 * EXPIRACAO DA JANELA (Bloco 6e).
 *
 * Populacao COMPLEMENTAR a da reconciliacao (6b): la, `providerRef` NULO
 * significa 'chamamos o provedor e nao sabemos o que aconteceu'. Aqui,
 * `providerRef` PRESENTE significa "a cobranca existe e o provedor nunca
 * concluiu". A primeira se resolve PERGUNTANDO; esta, COMANDANDO o
 * cancelamento.
 *
 * A decisao pura e a varredura entram no incremento 2.
 */

/** Uma tentativa cuja cobranca existe e passou da janela. */
export interface TentativaExpirando {
  id: string;
  paymentId: string;
  attemptCount: number;
  /**
   * Nao-nulo por construcao do WHERE. Tipo proprio em vez de campo opcional em
   * `TentativaPresa`: opcional obrigaria checagem de null em runtime para algo
   * que a consulta ja garante, e checagem redundante ensina a proxima pessoa
   * que o campo pode faltar.
   */
  providerRef: string;
  /** Compoe o cursor da paginacao junto com o `id`. */
  createdAt: Date;
}

/**
 * O que fazer com uma tentativa expirando, dado o estado em que a cobranca
 * FICOU depois do comando de cancelamento.
 *
 * Nao existe variante `aguardar`, ao contrario da reconciliacao: la o job so
 * PERGUNTA, e esperar e resposta legitima. Aqui ja COMANDAMOS o cancelamento —
 * se mesmo assim a cobranca segue em processamento, isso e anomalia e vai para
 * triagem, nunca para uma nova rodada de espera silenciosa.
 */
export type AcaoDeExpiracao =
  /** Cancelamento confirmado no provedor: o pagamento vira EXPIRED. */
  | { tipo: 'expirar' }
  /** O provedor tem desfecho: aplica pelo MESMO caminho do fluxo normal. */
  | { tipo: 'aplicar'; resultado: ChargeResult }
  /** Estado que o job nao sabe aplicar com seguranca. Nao toca, e sinaliza. */
  | { tipo: 'triagem'; motivo: string };

/**
 * Funcao PURA: sem banco, sem provedor, sem relogio.
 *
 * O snapshot chega por DOIS caminhos que convergem: o retorno normal do
 * cancelCharge, ou — quando ele recusa com ChargeNotCancelableError — a leitura
 * subsequente do getCharge. Fazer os dois desaguarem no mesmo tipo e o que
 * permite UM ponto de decisao, em vez de regra de negocio espalhada por um
 * `catch`.
 *
 * A traducao de SUCCEEDED e DECLINED repete a de `decidirReconciliacao` de
 * proposito. Extrair criaria um modulo compartilhado para poucas linhas cuja
 * divergencia o COMPILADOR ja pega (os campos vem de ChargeResult), e acoplaria
 * duas decisoes que o projeto separou deliberadamente. A unica regra de
 * julgamento e a do `declineCode`, e ela esta explicada nos dois lugares.
 */
export function decidirExpiracao(snapshot: ChargeSnapshot): AcaoDeExpiracao {
  switch (snapshot.state) {
    case 'CANCELED':
      // Unico caminho que produz EXPIRED. O comando pegou: a cobranca esta
      // morta no provedor e o dinheiro reservado foi liberado.
      return { tipo: 'expirar' };

    case 'SUCCEEDED':
      // O provedor capturou ANTES do nosso comando. Marcar EXPIRED aqui
      // registraria como expirado um pagamento que cobrou o cliente — o pior
      // desfecho possivel deste job. Aplica a captura pelo caminho normal.
      return {
        tipo: 'aplicar',
        resultado: {
          providerRef: snapshot.providerRef,
          state: 'SUCCEEDED',
          capturedAmountCents: snapshot.capturedAmountCents,
        },
      };

    case 'DECLINED':
      // Mesma regra do CASO R6: declineCode e opcional no snapshot e
      // OBRIGATORIO no ChargeResult. Preencher com fachada gravaria mentira na
      // resposta congelada, devolvida ao cliente em todo replay.
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
      // Comandamos o cancelamento e a cobranca continua andando. Ou o provedor
      // ignorou, ou o estado mudou entre o comando e a leitura. Nao inventar
      // desfecho: preso e visivel e melhor que resolvido no escuro.
      return {
        tipo: 'triagem',
        motivo: 'cobranca segue em processamento apos comando de cancelamento',
      };
  }
}

export interface ExpiracaoDeps {
  /** Tentativas PENDING COM providerRef, criadas ANTES do limite e APOS o cursor. */
  buscarExpirando: (
    limite: Date,
    lote: number,
    apos?: CursorDaVarredura,
  ) => Promise<TentativaExpirando[]>;
  cancelarCobranca: (providerRef: string, idempotencyKey: string) => Promise<ChargeSnapshot>;
  consultarCobranca: (providerRef: string) => Promise<ChargeSnapshot>;
  expirar: (transactionId: string, providerRef: string) => Promise<boolean>;
  aplicar: (
    transactionId: string,
    providerRef: string,
    resultado: ChargeResult,
  ) => Promise<boolean>;
  agora?: () => Date;
  janelaMinutos?: number;
  lote?: number;
  maxLotes?: number;
}

export interface ResumoDaExpiracao {
  examinadas: number;
  expiradas: number;
  aplicadas: number;
  triagem: number;
  falhas: number;
  /** true = parou no teto de lotes, SEM provar que a fila acabou. */
  truncada: boolean;
  /** `null` quando a fila esgotou e o proximo ciclo recomeca do inicio. */
  proximoCursor: CursorDaVarredura | null;
}

function naFaixa(valor: number | undefined, padrao: number, min: number, max: number): number {
  if (valor === undefined || !Number.isInteger(valor)) return padrao;
  return Math.min(Math.max(valor, min), max);
}

/**
 * Chave de idempotencia do CANCELAMENTO.
 *
 * Prefixo obrigatorio, nao estetico: com provedor real a chave e global por
 * conta, entao reusar `paymentId:attemptCount` (a chave do createCharge) faria
 * o provedor devolver a resposta EM CACHE da cobranca em vez de cancelar.
 *
 * Estavel entre ciclos porque `attemptCount` nao muda enquanto o pagamento
 * esta PROCESSING — invariante da matriz de estados, ja usada pelo 6b.
 */
export function chaveDeCancelamento(
  paymentId: string,
  attemptCount: number,
  providerRef: string,
): string {
  return `cancel:${paymentId}:${attemptCount}:${providerRef}`;
}

/**
 * COMANDA o cancelamento e devolve o estado em que a cobranca ficou.
 *
 * Os dois caminhos convergem num unico ChargeSnapshot: o retorno normal, ou —
 * quando o provedor recusa porque JA CAPTUROU — a leitura seguinte. Aquela
 * recusa nao e falha, e INFORMACAO, e distingui-la por CLASSE (e nao por
 * mensagem) e o motivo de ChargeNotCancelableError existir. Tratada como falha
 * generica, um pagamento efetivamente cobrado do cliente ficaria preso.
 */
async function comandarCancelamento(
  deps: ExpiracaoDeps,
  candidata: TentativaExpirando,
): Promise<ChargeSnapshot> {
  let snapshot: ChargeSnapshot;

  try {
    snapshot = await deps.cancelarCobranca(
      candidata.providerRef,
      chaveDeCancelamento(candidata.paymentId, candidata.attemptCount, candidata.providerRef),
    );
  } catch (erro) {
    if (!(erro instanceof ChargeNotCancelableError)) throw erro;
    snapshot = await deps.consultarCobranca(candidata.providerRef);
  }

  // Achado 4.2 do review: um cancelamento aceito de forma ASSINCRONA devolve
  // PROCESSING, e a resposta do COMANDO fica congelada pela idempotencia do
  // provedor — todo ciclo seguinte releria o MESMO snapshot obsoleto e o
  // pagamento ficaria preso para sempre, que e o problema que este job existe
  // para eliminar. A CONSULTA nao passa pela chave: devolve estado vivo.
  if (snapshot.state === 'PROCESSING') {
    return deps.consultarCobranca(candidata.providerRef);
  }

  return snapshot;
}

export async function tickExpiracao(
  deps: ExpiracaoDeps,
  cursorInicial?: CursorDaVarredura,
): Promise<ResumoDaExpiracao> {
  const agora = deps.agora ? deps.agora() : new Date();
  const janela = naFaixa(deps.janelaMinutos, 15, 1, 1440);
  const lote = naFaixa(deps.lote, 20, 1, 500);
  const maxLotes = naFaixa(deps.maxLotes, 5, 1, 100);

  // Mesma razao da janela do 6b: sem ela o job cancelaria uma cobranca cuja
  // requisicao original ainda esta em voo.
  const limite = new Date(agora.getTime() - janela * 60_000);

  const resumo: ResumoDaExpiracao = {
    examinadas: 0,
    expiradas: 0,
    aplicadas: 0,
    triagem: 0,
    falhas: 0,
    truncada: false,
    proximoCursor: null,
  };

  let cursor = cursorInicial;

  for (let pagina = 0; pagina < maxLotes; pagina += 1) {
    const candidatas = await deps.buscarExpirando(limite, lote, cursor);
    if (candidatas.length === 0) return resumo;

    resumo.examinadas += candidatas.length;

    for (const candidata of candidatas) {
      try {
        const snapshot = await comandarCancelamento(deps, candidata);

        // Achado 4.1 do review: o snapshot TEM de ser da cobranca que pedimos.
        // Aplicar o estado de outra escreveria desfecho sobre o pagamento errado.
        // Fail-closed: triagem, sem nenhuma escrita.
        if (snapshot.providerRef !== candidata.providerRef) {
          resumo.triagem += 1;
          console.warn('[payment-service] snapshot de OUTRA cobranca', {
            transactionId: candidata.id,
            pedida: candidata.providerRef,
            recebida: snapshot.providerRef,
          });
          cursor = { createdAt: candidata.createdAt, id: candidata.id };
          continue;
        }

        const acao = decidirExpiracao(snapshot);

        switch (acao.tipo) {
          case 'expirar':
            if (await deps.expirar(candidata.id, candidata.providerRef)) resumo.expiradas += 1;
            break;
          case 'aplicar':
            if (await deps.aplicar(candidata.id, candidata.providerRef, acao.resultado)) {
              resumo.aplicadas += 1;
            }
            break;
          case 'triagem':
            resumo.triagem += 1;
            console.warn('[payment-service] expiracao em triagem', {
              transactionId: candidata.id,
              motivo: acao.motivo,
            });
            break;
        }
      } catch (erro) {
        // Falha tecnica NAO vira desfecho: a tentativa continua presa e visivel,
        // e volta no proximo ciclo. Aplicar no escuro mexe em dinheiro.
        resumo.falhas += 1;
        console.error('[payment-service] falha ao expirar tentativa', {
          transactionId: candidata.id,
          causa: mensagemSegura(erro, 'cancelamento da cobranca'),
        });
      }

      // Avanca SEMPRE, inclusive apos falha: item nao-acionavel continua
      // candidato e, sem isto, seguraria a varredura para sempre (achado 4.1
      // do PR #57).
      cursor = { createdAt: candidata.createdAt, id: candidata.id };
    }

    if (candidatas.length < lote) return resumo;
  }

  resumo.truncada = true;
  resumo.proximoCursor = cursor ?? null;
  return resumo;
}

export function criarVarreduraDeExpiracao(
  deps: ExpiracaoDeps,
): () => Promise<ResumoDaExpiracao> {
  let cursor: CursorDaVarredura | undefined;
  return async () => {
    const resumo = await tickExpiracao(deps, cursor);
    cursor = resumo.proximoCursor ?? undefined;
    return resumo;
  };
}
