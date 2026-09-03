import {
  PaymentStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
  WebhookStatus,
  type Payment,
  type PaymentTransaction,
  type PrismaClient,
} from '@prisma/client';
import { mapearEstadoDoProvedor, podeTransicionar } from '../domain/payment-status';
import { enqueue } from '../events/outbox.repository';
import { montarEventoDeCaptura } from '../events/payment.events';
import type { WebhookEventPayload } from '../providers/payment-provider.port';
import { mensagemSegura } from '../domain/mensagem-segura';

/**
 * Quanto o `providerCreatedAt` pode estar a FRENTE do nosso relogio.
 *
 * Achado 3.1 do review do PR #59. O campo vem do payload do provedor, e a
 * assinatura prova a ORIGEM dos bytes, nao a PLAUSIBILIDADE do valor — a mesma
 * licao que o Bloco 4 registrou ao criar a checagem de coerencia monetaria.
 * Como o valor vira MARCADOR PERSISTENTE, um unico evento com timestamp muito
 * futuro bloquearia todas as transicoes seguintes daquele pagamento, para
 * sempre: negacao de servico por pagamento, e terminal.
 *
 * Constante, e nao configuracao: e tolerancia a desvio de relogio, grandeza
 * tecnica sem decisao de negocio. Vai para o AppConfig no dia em que alguem
 * precisar ajusta-la por ambiente.
 */
const TOLERANCIA_DE_FUTURO_MS = 5 * 60_000;

export interface WebhookServiceDeps {
  prisma: PrismaClient;
  /** Ver AppConfig.webhookMaxAttempts. Sem default: o teto e decisao, nao detalhe. */
  tetoDeTentativas: number;
  /** Ver AppConfig.webhookQuarantineMinutes. */
  idadeMaximaMinutos: number;
}

export interface ResultadoDeWebhook {
  status: WebhookStatus;
  /**
   * Condicao possivelmente TRANSITORIA: o evento nao pode ser aplicado agora,
   * mas pode vir a ser. A rota traduz em 5xx para o provedor retentar. Marcar
   * como terminal e responder 200 perderia o efeito financeiro para sempre.
   */
  retentavel?: boolean;
  motivo?: string;
}

/**
 * Sanitizacao em ESCRITA: ALLOWLIST POR CAMINHO, com denylist por cima.
 *
 * Historico da decisao, porque ela mudou duas vezes sob review. Comecou como
 * denylist pura, com o argumento de que o inbox existe para preservar evidencia
 * de campos desconhecidos. Tres rodadas de review encontraram aliases PCI/SAD
 * novos escapando — campo desconhecido NAO e campo seguro, e enumerar nomes e
 * corrida infinita. Virou allowlist por NOME, e a quarta rodada mostrou que
 * allowlist por nome e contornavel com estrutura aninhada.
 *
 * Modelo final:
 *   1. o contrato de fio e uma ARVORE (CONTRATO_RAIZ); so ele preserva valor;
 *   2. fora dele, a FORMA e preservada e toda folha vira [nao-reconhecido];
 *   3. a denylist marca [redigido] no que sabemos ser segredo — informacao
 *      diferente de [nao-reconhecido] para quem tria;
 *   4. teto de profundidade e de itens por array, contra payload-bomba.
 */
/**
 * Quebra a chave em SEGMENTOS: `card_cvv`, `cardCvv` e `card-cvv` viram todos
 * ['card', 'cvv']. O sufixo numerico e removido para `cvv2` casar com `cvv`.
 *
 * Existe por causa do achado 3.1 da segunda rodada de review: correspondencia
 * exata sobre a chave INTEIRA deixava passar toda variante composta.
 */
function segmentos(chave: string): string[] {
  return chave
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((parte) => parte !== '')
    .map((parte) => parte.replace(/[0-9]+$/, ''));
}

/**
 * Casados por SEGMENTO exato, nunca por substring. Sao nomes curtos onde
 * substring geraria falso positivo: `company` e `expansion` contem "pan",
 * e redigir tudo que contem "pan" destruiria dado util de triagem.
 */
/**
 * Campos do CONTRATO DE FIO. So estes preservam VALOR no inbox.
 *
 * Mudanca de abordagem apos a 3a rodada de review: denylist sozinha exigia
 * enumerar todo alias PCI/SAD existente, e tres rodadas seguidas encontraram
 * nomes novos (`card_cvv`, depois `security_code`, `pin_block`, `track2`,
 * `cryptogram`). Campo desconhecido NAO e campo seguro: o default passa a ser
 * fail-closed. A CHAVE e preservada para o operador saber que o campo veio; o
 * VALOR, nao.
 */
interface NoDoContrato {
  /** Chaves cujo valor ESCALAR e preservado neste nivel. NOME EXATO do wire. */
  escalares: ReadonlySet<string>;
  /**
   * Chaves cujo valor e objeto e continua sob contrato.
   *
   * Map, e nao objeto literal (achado 4.1 da 5a rodada): num literal, a busca
   * pela chave constructor devolve a propriedade HERDADA de Object.prototype,
   * que nao e undefined e era tratada como no do contrato. A recursao seguinte
   * estourava TypeError, virava 500, e o provedor retentava para sempre.
   */
  objetos: ReadonlyMap<string, NoDoContrato>;
}

/**
 * NOMES EXATOS do formato de fio, SEM normalizacao (achado 3.1 da 5a rodada).
 *
 * normalizar() continua existindo, mas so na DENYLIST. As duas listas tem
 * exigencias opostas: a denylist precisa ser TOLERANTE a variacao de escrita
 * para pegar x-api-key e cardNumber; a allowlist precisa ser ESTRITA, porque
 * tolerancia ali vira ampliacao do contrato — i-d normalizava para id e
 * passava a preservar valor na raiz.
 */
const CONTRATO_DA_COBRANCA: NoDoContrato = {
  escalares: new Set([
    'charge_ref',
    'state',
    'captured_amount_cents',
    'refunded_amount_cents',
    'decline_code',
  ]),
  objetos: new Map(),
};

const CONTRATO_RAIZ: NoDoContrato = {
  escalares: new Set(['id', 'type', 'created_at']),
  objetos: new Map([['data', CONTRATO_DA_COBRANCA]]),
};

function normalizar(chave: string): string {
  return chave.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SEGMENTOS_SENSIVEIS = new Set([
  'pan', 'card', 'number', 'cvv', 'cvc', 'iban', 'token', 'secret',
  'pin', 'track',
  'password', 'senha',
]);

/**
 * Casadas por SUBSTRING na chave normalizada. Sao longas o bastante para nao
 * colidir com palavra comum, e pegam variantes que a segmentacao sozinha nao
 * pega: `x-api-key` normaliza para `xapikey`, que contem `apikey`.
 */
const RAIZES_SENSIVEIS = [
  'token', 'secret', 'password', 'senha', 'authorization', 'apikey',
  'privatekey', 'cardnumber', 'creditcard', 'accountnumber', 'cvv', 'cvc',
  'securitycode', 'verificationvalue', 'verificationcode', 'pinblock',
  'trackdata', 'magstripe', 'cryptogram', 'emvdata', 'servicecode',
  'iban',
];

function ehSensivel(chave: string): boolean {
  const normalizada = normalizar(chave);
  if (RAIZES_SENSIVEIS.some((raiz) => normalizada.includes(raiz))) return true;
  return segmentos(chave).some((parte) => SEGMENTOS_SENSIVEIS.has(parte));
}
const PROFUNDIDADE_MAXIMA = 8;
const ITENS_MAXIMOS = 100;

/**
 * `no === null` significa MODO ESTRUTURA: estamos fora do contrato, a forma e
 * preservada para triagem e toda folha perde o valor. A allowlist NUNCA e
 * reativada dentro desse modo.
 */
function sanitizar(valor: unknown, no: NoDoContrato | null, profundidade = 0): unknown {
  if (profundidade > PROFUNDIDADE_MAXIMA) return '[profundidade excedida]';

  // Nenhum campo do contrato e array: todo array e territorio desconhecido.
  if (Array.isArray(valor)) {
    return valor
      .slice(0, ITENS_MAXIMOS)
      .map((item) => sanitizar(item, null, profundidade + 1));
  }

  if (valor !== null && typeof valor === 'object') {
    // Object.create(null) protege a construcao deste objeto contra poluicao de
    // prototipo. NAO basta para o `__proto__`: comprovado por diagnostico
    // isolado, a chave existe ao gravar e some ao ler — o round-trip do
    // Prisma/Postgres reconstroi o objeto com atribuicao comum e ela reescreve
    // o prototipo. Por isso ela e RENOMEADA abaixo: evidencia marcada e
    // aceitavel, evidencia que some em silencio nao e.
    const saida = Object.create(null) as Record<string, unknown>;

    for (const [chave, v] of Object.entries(valor)) {
      // Chave que nao sobrevive a persistencia e gravada com marca explicita.
      const nomeDeSaida = chave === '__proto__' ? '__proto__ [renomeado]' : chave;

      if (ehSensivel(chave)) {
        saida[nomeDeSaida] = '[redigido]';
        continue;
      }
      const ehEstrutura = Array.isArray(v) || (v !== null && typeof v === 'object');
      // Comparacao EXATA e por Map: sem normalizacao, sem heranca de prototipo.
      const filho = no === null ? undefined : no.objetos.get(chave);

      if (filho !== undefined && ehEstrutura) {
        saida[nomeDeSaida] = sanitizar(v, filho, profundidade + 1);
        continue;
      }
      if (!ehEstrutura && no !== null && no.escalares.has(chave)) {
        saida[nomeDeSaida] = v;
        continue;
      }
      // Fora do contrato: estrutura recursa em MODO ESTRUTURA, escalar perde o valor.
      saida[nomeDeSaida] = ehEstrutura
        ? sanitizar(v, null, profundidade + 1)
        : '[nao-reconhecido]';
    }
    return saida;
  }

  // Folha: so chega aqui em modo estrutura; no caminho do contrato o valor ja
  // foi devolvido pelo ramo de escalares acima.
  return no === null ? '[nao-reconhecido]' : valor;
}


type Registro = { id: string } | { duplicata: WebhookStatus };

/** As tres variantes que mexem no ESTADO do pagamento. */
type EventoDeCobranca = Extract<WebhookEventPayload, { eventType: 'payment.succeeded' }> | Extract<WebhookEventPayload, { eventType: 'payment.failed' }> | Extract<WebhookEventPayload, { eventType: 'payment.canceled' }>;

/** Reembolso: nao transiciona status, move refundedAmountCents. */
type EventoDeReembolso = Extract<WebhookEventPayload, { eventType: 'refund.succeeded' }>;

export class WebhookService {
  constructor(private readonly deps: WebhookServiceDeps) {}

  /**
   * REGISTRAR -> DECIDIR -> APLICAR, nesta ordem.
   *
   * Aplicar antes de registrar significa que uma queda entre os dois faz a
   * proxima entrega reaplicar. Registrar primeiro deixa o evento visivel como
   * pendente e recuperavel.
   *
   * LIMITE CONHECIDO (achado 5.1 do review): isto e REGISTRO DURAVEL ANTES DO
   * EFEITO, e NAO claim exclusivo. O `create` do inbox acontece FORA da
   * transacao que altera pagamento, trilha e status final — duas entregas
   * concorrentes do mesmo evento podem ambas prosseguir. O dinheiro fica
   * protegido pelo compare-and-swap, e toda escrita de desfecho e condicionada a
   * RECEIVED/FAILED, entao FAILED nao sobrescreve terminal. O que RESTA e a
   * disputa entre conclusoes concorrentes sobre a MESMA linha: trilha imprecisa,
   * nunca duplicacao de dinheiro. Claim exclusivo exige valor
   * novo no enum ou coluna de lease, ou seja migracao: registrado para o Bloco 6.
   */
  async processar(
    providerName: string,
    evento: WebhookEventPayload,
  ): Promise<ResultadoDeWebhook> {
    const registro = await this.registrar(providerName, evento);
    if ('duplicata' in registro) return { status: registro.duplicata };

    try {
      const resultado = await this.decidirEAplicar(registro.id, evento);
      if (resultado.retentavel !== true) return resultado;

      // A populacao `retentavel` nao passa pelo catch, entao `attempts` nunca
      // sobe e o teto nunca a alcanca. Ela e limitada por IDADE.
      const porIdade = await this.quarentenarPorIdade(registro.id, resultado.motivo);
      return porIdade ?? resultado;
    } catch (erro) {
      // GUARDA DE CONCORRENCIA (achado 4.1 da 2a rodada): so marca FAILED se a
      // linha ainda NAO foi concluida. Sem isto, uma execucao que falha
      // sobrescreve como FAILED o PROCESSED que a execucao concorrente acabou de
      // gravar, e a reconciliacao passa a ver como pendente um evento aplicado.
      // Nao substitui o claim exclusivo (Bloco 6); remove o pior sintoma dele.
      const mensagem = mensagemSegura(erro, 'processamento do webhook');
      const marcadas = await this.deps.prisma.webhookEvent.updateMany({
        where: {
          id: registro.id,
          status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
        },
        data: {
          status: WebhookStatus.FAILED,
          attempts: { increment: 1 },
          lastError: mensagem,
        },
      });

      // Nada marcado = execucao concorrente ja concluiu a linha. Nao ha teto a
      // avaliar sobre uma contagem que nao foi nossa.
      if (marcadas.count === 0) throw erro;

      const quarentena = await this.quarentenarPorTeto(registro.id, mensagem);
      if (quarentena !== null) return quarentena;

      throw erro;
    }
  }

  /**
   * Desfecho RETENTAVEL: registra o motivo na linha e devolve 5xx para o
   * provedor reentregar.
   *
   * A guarda de estado impede escrever sobre linha ja concluida por execucao
   * concorrente. E o `count` IMPORTA (achado 4.3): se outra execucao concluiu ou
   * quarentenou a linha entre a decisao e esta escrita, responder retentavel
   * pediria reentrega de algo ja terminal. Nesse caso devolvemos o estado REAL,
   * que a rota traduz em 200.
   *
   * Compartilhado pelos DOIS ramos retentaveis: os dois ignoravam o `count`, e
   * corrigir so o novo criaria assimetria entre caminhos que fazem o mesmo.
   */
  private async comoRetentavel(registroId: string, motivo: string): Promise<ResultadoDeWebhook> {
    const { count } = await this.deps.prisma.webhookEvent.updateMany({
      where: {
        id: registroId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
      },
      data: { lastError: motivo },
    });

    if (count === 0) {
      const linha = await this.deps.prisma.webhookEvent.findUnique({
        where: { id: registroId },
        select: { status: true },
      });
      if (linha !== null) return { status: linha.status, motivo };
    }

    return { status: WebhookStatus.RECEIVED, motivo, retentavel: true };
  }

  /**
   * Quarentena por IDADE (Bloco 6c).
   *
   * Um desfecho `retentavel` devolve 5xx e o provedor reentrega, mas NAO
   * incrementa `attempts` (achado 4.5 do Bloco 4: essa coluna conta tentativas
   * que falharam com excecao, e so o catch a move). Sem limite por idade essa
   * populacao gira ate o provedor desistir sozinho, e nada do nosso lado
   * registra que desistimos.
   *
   * Mesmo idioma do teto: a condicao vive no WHERE, entao a comparacao de tempo
   * e feita pelo banco sobre a linha real, e o `count` diz se houve transicao.
   * Preserva a guarda de estado, que impede sobrescrever linha ja concluida por
   * execucao concorrente.
   */
  private async quarentenarPorIdade(
    registroId: string,
    motivoOriginal?: string,
  ): Promise<ResultadoDeWebhook | null> {
    const limite = new Date(Date.now() - this.deps.idadeMaximaMinutos * 60_000);
    const motivo = `inaplicavel ha mais de ${this.deps.idadeMaximaMinutos} minutos`;

    const emQuarentena = await this.deps.prisma.webhookEvent.updateMany({
      where: {
        id: registroId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
        receivedAt: { lt: limite },
      },
      data: {
        status: WebhookStatus.QUARANTINED,
        processedAt: new Date(),
        lastError: (motivoOriginal ? `${motivo} | ${motivoOriginal}` : motivo).slice(0, 500),
      },
    });
    if (emQuarentena.count === 0) return null;

    return { status: WebhookStatus.QUARANTINED, motivo };
  }

  /**
   * Teto de tentativas (Bloco 6c).
   *
   * Falha DETERMINISTICA — bug no handler, ou dado que nunca vai validar —
   * lanca a cada reentrega, a rota responde 5xx, e o provedor reentrega de
   * novo. Sem teto o laco nao termina, e cada volta reprocessa o evento
   * inteiro. `attempts` conta exatamente esta populacao (achado 4.5 do Bloco 4:
   * quem incrementa e este catch, e so ele).
   *
   * A CONDICAO do teto vive no WHERE, nao numa leitura previa. O banco avalia
   * o valor JA incrementado na mesma instrucao que transiciona, e o `count` da
   * resposta diz se a quarentena aconteceu. Ler antes e decidir em JavaScript
   * custaria uma consulta a mais por falha e abriria janela entre ler e
   * escrever — duas execucoes poderiam ler o mesmo valor e ambas transicionar.
   *
   * Devolve `null` quando o teto ainda nao foi atingido; ai o chamador relanca
   * e a rota responde 5xx como antes.
   */
  private async quarentenarPorTeto(
    registroId: string,
    ultimoErro: string,
  ): Promise<ResultadoDeWebhook | null> {
    const motivo = `teto de ${this.deps.tetoDeTentativas} tentativas atingido`;

    const emQuarentena = await this.deps.prisma.webhookEvent.updateMany({
      where: {
        id: registroId,
        // Somente sobre a linha que ACABAMOS de marcar como FAILED.
        status: WebhookStatus.FAILED,
        attempts: { gte: this.deps.tetoDeTentativas },
      },
      data: {
        status: WebhookStatus.QUARANTINED,
        // Nao e "processado": e o instante em que DESISTIMOS. O WebhookEvent
        // nao tem updatedAt, entao sem isto esse momento se perde. Mesma
        // imprecisao de nome que o lastError ja carrega ao guardar motivo de
        // IGNORED — registrada para renomeacao no Bloco 10.
        processedAt: new Date(),
        lastError: `${motivo} | ultimo erro: ${ultimoErro}`.slice(0, 500),
      },
    });
    if (emQuarentena.count === 0) return null;

    // SEM relancar: a rota responde 200 e o provedor PARA de reentregar. E o
    // proposito do teto — seguir respondendo 5xx manteria o laco vivo do lado
    // de la, com a linha ja marcada como desistida do lado de ca.
    return { status: WebhookStatus.QUARANTINED, motivo };
  }

  private async registrar(
    providerName: string,
    evento: WebhookEventPayload,
  ): Promise<Registro> {
    try {
      const criado = await this.deps.prisma.webhookEvent.create({
        data: {
          provider: providerName,
          providerEventId: evento.providerEventId,
          // Tipo BRUTO: gravar 'unsupported' perderia o que o operador precisa para triar.
          eventType: evento.providerEventTypeBruto,
          payload: sanitizar(evento.raw, CONTRATO_RAIZ) as Prisma.InputJsonValue,
          providerCreatedAt: evento.providerCreatedAt,
          status: WebhookStatus.RECEIVED,
        },
      });
      return { id: criado.id };
    } catch (erro) {
      if (!(erro instanceof Prisma.PrismaClientKnownRequestError) || erro.code !== 'P2002') {
        throw erro;
      }

      const existente = await this.deps.prisma.webhookEvent.findUniqueOrThrow({
        where: {
          provider_providerEventId: {
            provider: providerName,
            providerEventId: evento.providerEventId,
          },
        },
      });

      // Colisao NAO e resposta final. PROCESSED/IGNORED foi decidido: duplicata real.
      // A lista e dos estados ABERTOS, nao dos terminais — e a inversao e a
      // correcao, nao estilo. Enumerar terminais faz qualquer estado FUTURO
      // herdar o caminho de REPROCESSAMENTO por omissao, que foi exatamente
      // como QUARANTINED nasceu perigoso: as guardas do `catch` e do `encerrar`
      // filtram `status in (RECEIVED, FAILED)`, entao uma reentrega que
      // reprocessasse uma linha terminal aplicaria o efeito financeiro SEM
      // conseguir gravar o desfecho — a linha ficaria como estava e a reentrega
      // seguinte aplicaria DE NOVO. Captura dupla, silenciosa.
      //
      // Com a lista invertida, um valor de enum que ESTA versao nao conhece e
      // tratado como terminal: fail-closed por construcao. Achado 4.1 da 2a
      // rodada de review do PR #58.
      //
      // Sair de um estado terminal e acao humana: voltar a linha para RECEIVED
      // depois de resolver a causa.
      const aberto =
        existente.status === WebhookStatus.RECEIVED || existente.status === WebhookStatus.FAILED;
      if (!aberto) {
        return { duplicata: existente.status };
      }

      // RECEIVED/FAILED significa que o efeito NUNCA aconteceu — queda entre
      // gravar e aplicar. Tratar isso como duplicata prenderia o pagamento
      // para sempre por uma falha transitoria.
      //
      // NAO incrementa `attempts` aqui (achado 4.5): a semantica e TENTATIVAS
      // QUE FALHARAM, e quem incrementa e o `catch` de `processar`. Incrementar
      // nos dois lugares contava duas vezes a mesma tentativa e anteciparia o
      // teto/quarentena planejado para o Bloco 6.
      return { id: existente.id };
    }
  }

  private async decidirEAplicar(
    registroId: string,
    evento: WebhookEventPayload,
  ): Promise<ResultadoDeWebhook> {
    // FAIL-CLOSED: preferimos um webhook parado a um pagamento sobrescrito por
    // um evento que nao sabemos ordenar.
    if (evento.providerCreatedAt === null) {
      return this.encerrar(registroId, WebhookStatus.IGNORED, 'evento sem providerCreatedAt');
    }

    // Nao-nulo daqui para baixo. Capturado numa const para o compilador nao
    // depender de estreitamento sobre propriedade ao longo de todo o metodo.
    const ocorridoEm = evento.providerCreatedAt;

    const ocorridoEmMs = ocorridoEm.getTime();

    // TIMESTAMP MALFORMADO (achado 3.2). `Invalid Date` faz `getTime()` devolver
    // NaN, e TODA comparacao com NaN e falsa — o valor atravessaria o portao
    // abaixo e chegaria ao banco. Terminal, e nao retentavel: reentregar nao
    // conserta um timestamp que veio quebrado.
    if (!Number.isFinite(ocorridoEmMs)) {
      return this.encerrar(registroId, WebhookStatus.IGNORED, 'providerCreatedAt invalido');
    }

    if (evento.eventType === 'unsupported') {
      return this.encerrar(
        registroId,
        WebhookStatus.IGNORED,
        `tipo nao tratado: ${evento.providerEventTypeBruto}`,
      );
    }

    const transacao = await this.deps.prisma.paymentTransaction.findFirst({
      where: { providerRef: evento.providerRef, type: TransactionType.AUTHORIZE },
      orderBy: { createdAt: 'asc' },
    });
    if (transacao === null) {
      // Achado 4.2 do review. O `providerRef` so e persistido no
      // `registrarDesfecho`, DEPOIS da resposta do provedor: a linha write-ahead
      // nasce com `providerRef` nulo. Um webhook pode chegar antes desse commit.
      // A linha fica em RECEIVED (nao IGNORED, nao `processedAt`) e a rota
      // responde 5xx para o provedor retentar. O teto de tentativas e a
      // quarentena sao do Bloco 6.
      // Mesma guarda do catch e do encerrar: nao escreve sobre linha ja
      // concluida por execucao concorrente (achado 4.1 da 3a rodada).
      return this.comoRetentavel(registroId, 'providerRef ainda desconhecido');
    }

    const payment = await this.deps.prisma.payment.findUniqueOrThrow({
      where: { id: transacao.paymentId },
    });

    // ANTES do mapeamento de estado: refund.succeeded carrega state SUCCEEDED,
    // que mapearia para CAPTURED e cairia no curto-circuito abaixo — o
    // reembolso seria descartado como "estado ja aplicado".
    if (evento.eventType === 'refund.succeeded') {
      return this.aplicarReembolso(registroId, evento, payment);
    }

    // PLAUSIBILIDADE DO TIMESTAMP — guarda APENAS o caminho que escreve
    // `lastProviderEventAt`.
    //
    // Estava tres passos acima, antes do roteamento de reembolso e da
    // classificacao de `unsupported`, e por isso retinha os dois (achados 4.1 e
    // 4.2 da 5a rodada). No reembolso o dano e financeiro e contradiz a decisao
    // declarada no schema e provada pelo CASO 44: um `refund.succeeded` seis
    // minutos a frente ficava retentavel, nunca aplicava o delta e terminava em
    // quarentena — dinheiro devolvido pelo provedor sem registro nosso. La a
    // defesa de ordenacao e o delta sobre `refundedAmountCents`, que compara
    // VALOR e nao depende de relogio nenhum.
    //
    // RETENTAVEL, e nao terminal: o outro lado da comparacao, `Date.now()`,
    // muda. O caminho terminal e a quarentena por IDADE do Bloco 6c.
    if (ocorridoEmMs > Date.now() + TOLERANCIA_DE_FUTURO_MS) {
      return this.comoRetentavel(registroId, 'providerCreatedAt alem da tolerancia de futuro');
    }

    const novoStatus = mapearEstadoDoProvedor(evento.state);

    // Invariante monetaria ANTES do curto-circuito de idempotencia (achado 4.4).
    // A assinatura prova a ORIGEM dos bytes, nao a COERENCIA do valor. Se esta
    // checagem viesse depois, um segundo evento com valor divergente sobre um
    // pagamento JA capturado seria aceito como PROCESSED e a divergencia nunca
    // chegaria a triagem.
    if (
      evento.eventType === 'payment.succeeded' &&
      evento.capturedAmountCents !== payment.amountCents
    ) {
      return this.encerrar(
        registroId,
        WebhookStatus.IGNORED,
        'valor capturado diverge do cobrado',
      );
    }

    // podeTransicionar(X, X) devolve true DE PROPOSITO (replay nao e transicao).
    // Sem este curto-circuito, um SEGUNDO evento distinto reportando o mesmo
    // estado criaria uma segunda linha CAPTURE — a trilha diria que o dinheiro
    // foi capturado duas vezes.
    if (novoStatus === payment.status) {
      return this.encerrar(registroId, WebhookStatus.PROCESSED);
    }

    if (!podeTransicionar(payment.status, novoStatus)) {
      return this.encerrar(
        registroId,
        WebhookStatus.IGNORED,
        `transicao ${payment.status} -> ${novoStatus} nao permitida`,
      );
    }

    const aplicado = await this.deps.prisma.$transaction(async (tx) => {
      // COMPARE-AND-SWAP: o status lido entra no WHERE. Se outro processo mudou
      // o pagamento entre a leitura e a escrita, count = 0 e nada e aplicado.
      const { count } = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: payment.status,
          // ORDENACAO FINA (Bloco 6d). `podeTransicionar` cuida da ordem entre
          // ESTADOS; isto cuida da ordem entre EVENTOS. O marcador e GLOBAL
          // entre eventos de TRANSICAO — nao ha um por tipo: dois eventos com
          // providerCreatedAt diferentes passam pelas mesmas checagens, e o
          // mais ANTIGO chegando depois sobrescreveria o efeito do mais novo.
          //
          // A condicao vive AQUI, atomica com a escrita, e nao num ramo em
          // JavaScript antes da transacao. Existiu um ramo assim, e a bateria
          // mostrou que ele nao mudava NADA: o evento obsoleto perde o CAS, cai
          // na releitura abaixo, e e encerrado la com o mesmo motivo. A mesma
          // condicao em tres lugares so cria chance de divergirem.
          OR: [{ lastProviderEventAt: null }, { lastProviderEventAt: { lt: ocorridoEm } }],
        },
        data: {
          status: novoStatus,
          // O marcador avanca na MESMA instrucao do efeito: gravar depois
          // deixaria uma janela em que o proximo evento antigo ainda passaria.
          lastProviderEventAt: ocorridoEm,
          ...(evento.eventType === 'payment.succeeded'
            ? { capturedAmountCents: evento.capturedAmountCents }
            : {}),
        },
      });
      if (count === 0) return false;

      await this.escreverTrilha(tx, payment, transacao, evento);

      // MESMA TRANSACAO do efeito. Publicar depois do commit abriria janela para
      // pagamento capturado sem evento; gravar antes, para efeito que falha,
      // avisaria o order de um pagamento que nao aconteceu.
      if (evento.eventType === 'payment.succeeded') {
        await enqueue(
          tx,
          montarEventoDeCaptura(
            {
              paymentId: payment.id,
              orderId: payment.orderId,
              amountCents: payment.amountCents,
              capturedAmountCents: evento.capturedAmountCents,
              currency: payment.currency,
            },
            new Date(),
          ),
        );
      }

      // SEM guarda de estado, ao contrario do `encerrar`, do `catch` e do ramo
      // retentavel — e a assimetria e deliberada. So se chega aqui tendo GANHO o
      // compare-and-swap acima, ou seja, tendo aplicado o efeito financeiro.
      // Marcar PROCESSED por cima de IGNORED ou QUARANTINED e dizer a verdade.
      // Com guarda, o dinheiro teria se movido e a linha NAO registraria isso.
      await tx.webhookEvent.update({
        where: { id: registroId },
        data: { status: WebhookStatus.PROCESSED, processedAt: new Date(), lastError: null },
      });
      return true;
    });

    if (!aplicado) {
      // ACHADO 4.2 do review: perder o CAS nao prova que o evento e obsoleto.
      // Recarrega e refaz a decisao sobre o estado REAL.
      const atual = await this.deps.prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });

      // Outro evento ja aplicou o MESMO desfecho: nao houve recusa.
      //
      // PRECEDENCIA DECLARADA (achado 4.2 do review do PR #59): esta checagem
      // vem ANTES da temporal de proposito. Se o estado ja e o que este evento
      // produziria, o desfecho e o mesmo e PROCESSED e a verdade — mesmo que
      // este evento seja mais antigo. Consequencia aceita: quando o evento
      // ANTIGO vence a corrida, o marcador fica no instante dele, e nao no do
      // mais novo. Nao ha dano (o estado e identico), e a monotonicidade do
      // marcador vale para eventos APLICADOS, nao para eventos recebidos.
      if (novoStatus === atual.status) {
        return this.encerrar(registroId, WebhookStatus.PROCESSED);
      }

      // Perdemos para um evento MAIS NOVO: este e obsoleto por tempo, mesmo que
      // a transicao continue permitida. Sem esta checagem, o ramo abaixo
      // devolveria "retentavel" e o provedor reentregaria um evento que nunca
      // vai poder ser aplicado — laco que so pararia no teto do 6c, e como
      // quarentena, nao como decisao.
      //
      // E AQUI que a ordenacao vira MOTIVO para a triagem: o WHERE do CAS
      // apenas impede a escrita, sem dizer por que. `<=` e nao `<`: dois
      // eventos com o mesmo instante nao tem ordem entre si, e o primeiro ja
      // aplicou — escolher o segundo seria decidir no escuro.
      // Capturado numa const e testado por VERACIDADE, nao por `!== null`: um
      // Date presente e sempre truthy, e a forma dispensa saber se a origem
      // devolve `null` ou `undefined`. Um TypeError aqui viraria 500, o
      // provedor reentregaria, `attempts` subiria e o evento acabaria em
      // quarentena por um defeito nosso.
      const ultimoAplicado = atual.lastProviderEventAt;
      if (ultimoAplicado) {
        // EMPATE tem motivo proprio: dizer "anterior" sobre dois eventos do
        // mesmo instante e gravar informacao errada na trilha, e a triagem le
        // exatamente esse campo. Sem ordem entre eles, o primeiro que aplicou
        // vence — escolher o segundo seria decidir no escuro.
        if (ocorridoEm.getTime() === ultimoAplicado.getTime()) {
          return this.encerrar(
            registroId,
            WebhookStatus.IGNORED,
            'mesmo instante do ultimo evento aplicado; sem ordem entre eles',
          );
        }
        if (ocorridoEm < ultimoAplicado) {
          return this.encerrar(
            registroId,
            WebhookStatus.IGNORED,
            'evento anterior ao ultimo ja aplicado neste pagamento',
          );
        }
      }

      // O estado avancou para algo que nao aceita mais esta transicao: obsoleto.
      if (!podeTransicionar(atual.status, novoStatus)) {
        return this.encerrar(
          registroId,
          WebhookStatus.IGNORED,
          `transicao ${atual.status} -> ${novoStatus} nao permitida apos releitura`,
        );
      }

      // Ainda aplicavel — so perdemos a corrida. Retentavel, nunca terminal.
      return {
        status: WebhookStatus.RECEIVED,
        motivo: 'corrida no compare-and-swap do status',
        retentavel: true,
      };
    }
    return { status: WebhookStatus.PROCESSED };
  }

  private async escreverTrilha(
    tx: Prisma.TransactionClient,
    payment: Payment,
    transacao: PaymentTransaction,
    evento: EventoDeCobranca,
  ): Promise<void> {
    // Trilha financeira nunca e REESCRITA: so resolvemos a autorizacao que
    // ainda esta em aberto. Se ela ja tem desfecho, o registro dele permanece.
    const autorizacaoEmAberto = transacao.status === TransactionStatus.PENDING;

    switch (evento.eventType) {
      case 'payment.succeeded': {
        if (autorizacaoEmAberto) {
          await tx.paymentTransaction.update({
            where: { id: transacao.id },
            data: { status: TransactionStatus.SUCCEEDED },
          });
        }
        // Captura automatica: as DUAS etapas aconteceram. Registrar so o
        // AUTHORIZE deixaria a trilha incompleta (mesma regra do POST /payments).
        await tx.paymentTransaction.create({
          data: {
            paymentId: payment.id,
            type: TransactionType.CAPTURE,
            status: TransactionStatus.SUCCEEDED,
            amountCents: evento.capturedAmountCents,
            providerRef: evento.providerRef,
          },
        });
        break;
      }

      case 'payment.failed': {
        if (autorizacaoEmAberto) {
          await tx.paymentTransaction.update({
            where: { id: transacao.id },
            data: {
              status: TransactionStatus.FAILED,
              failureCode: evento.declineCode ?? 'provider_declined',
            },
          });
        }
        break;
      }

      case 'payment.canceled': {
        // ACHADO 4.6 do PR #52. Sem isto o pagamento fica CANCELED (terminal)
        // com a AUTHORIZE ainda PENDING — a trilha afirmaria que a autorizacao
        // segue em aberto.
        //
        // TransactionStatus nao tem CANCELED; FAILED + failureCode explicito
        // carrega a distincao sem migracao de enum. A linha VOID seria correta
        // se a autorizacao tivesse SUCEDIDO antes do cancelamento, mas
        // AUTHORIZED nao tem produtor sob captura automatica (decisao 10 da
        // fase) — seria codigo morto. Registrado no TECH_DEBT com gatilho:
        // captura em duas fases.
        if (autorizacaoEmAberto) {
          await tx.paymentTransaction.update({
            where: { id: transacao.id },
            data: { status: TransactionStatus.FAILED, failureCode: 'PROVIDER_CANCELED' },
          });
        }
        break;
      }
    }
  }

  /** Teto de reavaliacoes apos CAS perdido. Acima disso e contencao real. */
  private static readonly MAX_REAVALIACOES = 3;

  private async aplicarReembolso(
    registroId: string,
    evento: EventoDeReembolso,
    paymentInicial: Payment,
  ): Promise<ResultadoDeWebhook> {
    let payment = paymentInicial;

    // ACHADO 4.1 do review. Perder o CAS NAO prova que o evento e obsoleto:
    // pode ser que um reembolso concorrente de valor MENOR tenha chegado
    // primeiro. Encerrar como IGNORED com 200 fazia o provedor nao retentar e o
    // banco ficar ABAIXO do total realmente reembolsado. Aqui o estado e
    // RECARREGADO e a decisao refeita sobre ele.
    for (let tentativa = 0; tentativa <= WebhookService.MAX_REAVALIACOES; tentativa += 1) {
      if (payment.status !== PaymentStatus.CAPTURED) {
        return this.encerrar(
          registroId,
          WebhookStatus.IGNORED,
          `reembolso exige CAPTURED, status atual ${payment.status}`,
        );
      }

      // Fail-closed sobre dinheiro: o wire so valida nao-negativo e teto
      // absoluto, e nao conhece o NOSSO estado.
      if (evento.refundedAmountCents > payment.capturedAmountCents) {
        return this.encerrar(
          registroId,
          WebhookStatus.IGNORED,
          'reembolso acima do valor capturado',
        );
      }

      // O evento carrega o TOTAL reembolsado; a linha da trilha registra ESTA
      // movimentacao. Delta <= 0 significa que o total ja esta refletido:
      // replay ou evento obsoleto, e isso e PROCESSED, nao recusa.
      const delta = evento.refundedAmountCents - payment.refundedAmountCents;
      if (delta <= 0) {
        return this.encerrar(registroId, WebhookStatus.PROCESSED);
      }

      const baseDoCas = payment.refundedAmountCents;
      const idDoPagamento = payment.id;

      const aplicado = await this.deps.prisma.$transaction(async (tx) => {
        // CAS sobre o VALOR, nao sobre o status: CAPTURED e terminal e nao muda
        // (decisao 9 da fase — reembolso e aritmetica, nao transicao).
        const { count } = await tx.payment.updateMany({
          where: { id: idDoPagamento, refundedAmountCents: baseDoCas },
          data: { refundedAmountCents: evento.refundedAmountCents },
        });
        if (count === 0) return false;

        await tx.paymentTransaction.create({
          data: {
            paymentId: idDoPagamento,
            type: TransactionType.REFUND,
            status: TransactionStatus.SUCCEEDED,
            amountCents: delta,
            providerRef: evento.providerRef,
          },
        });
        // Mesma assimetria deliberada do caminho de captura: so se chega aqui
        // tendo ganho o CAS do valor, entao o reembolso foi aplicado.
        await tx.webhookEvent.update({
          where: { id: registroId },
          data: { status: WebhookStatus.PROCESSED, processedAt: new Date(), lastError: null },
        });
        return true;
      });

      if (aplicado) return { status: WebhookStatus.PROCESSED };

      payment = await this.deps.prisma.payment.findUniqueOrThrow({
        where: { id: idDoPagamento },
      });
    }

    // Contencao alta demais para resolver nesta entrega. NAO e recusa: a linha
    // fica RECEIVED e a rota devolve 5xx para o provedor retentar.
    return {
      status: WebhookStatus.RECEIVED,
      motivo: 'contencao no compare-and-swap do reembolso',
      retentavel: true,
    };
  }

  private async encerrar(
    registroId: string,
    status: WebhookStatus,
    motivo?: string,
  ): Promise<ResultadoDeWebhook> {
    // Mesma guarda do catch: desfecho so e gravado sobre linha nao concluida.
    await this.deps.prisma.webhookEvent.updateMany({
      where: {
        id: registroId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED] },
      },
      data: {
        status,
        processedAt: new Date(),
        // lastError so em desfecho que exige triagem. PROCESSED nao carrega erro.
        lastError: status === WebhookStatus.PROCESSED ? null : (motivo ?? null),
      },
    });
    return { status, motivo };
  }
}
