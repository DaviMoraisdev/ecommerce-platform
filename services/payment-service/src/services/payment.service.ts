import { createHash } from 'node:crypto';

import {
  PaymentStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
  type Payment,
  type PrismaClient,
} from '@prisma/client';

import {
  OrderClient,
  OrderIndisponivelError,
  OrderNaoAutorizadoError,
  OrderNaoEncontradoError,
  OrderRespostaInvalidaError,
  type PedidoDoOrder,
} from '../clients/order.client';
import { erroDeDominio, PaymentDomainError } from '../domain/errors';
import type { Currency } from '../domain/money';
import {
  PedidoNaoCobravelError,
  resolverValorDoPedido,
  ValorDoPedidoInvalidoError,
} from '../domain/order-amount';
import { assertTransicao, mapearEstadoDoProvedor } from '../domain/payment-status';
import {
  PaymentProviderError,
  ProviderInvalidRequestError,
  type PaymentProvider,
} from '../providers/payment-provider.port';
import { enqueue } from '../events/outbox.repository';
import { montarEventoDeCaptura } from '../events/payment.events';

export interface PaymentServiceDeps {
  prisma: PrismaClient;
  orderClient: OrderClient;
  provider: PaymentProvider;
  currency: Currency;
  windowMinutes: number;
  /** Injetavel para teste da janela de expiracao. */
  now?: () => Date;
}

export interface CriarPagamentoInput {
  userId: string;
  /** Cabecalho bruto, repassado ao order. */
  authorization: string;
  orderId: string;
  paymentMethodToken: string;
  idempotencyKey: string;
}

export interface PagamentoCriado {
  paymentId: string;
  orderId: string;
  status: PaymentStatus;
  amountCents: number;
  capturedAmountCents: number;
  currency: string;
  attemptCount: number;
  declineCode?: string;
  /**
   * true quando a resposta veio de replay idempotente, sem novo efeito.
   *
   * SEMANTICA (mudada no Bloco 6a): o replay devolve a resposta CONGELADA no
   * momento em que a chave finalizou, lida de IdempotencyRecord.completedResponse.
   * Nao le mais o Payment vivo.
   *
   * Antes disto, o replay lia o estado atual — e como o orderId e unique, a
   * segunda tentativa reusa a MESMA linha de Payment. Uma chave RECUSADA passava
   * a responder CAPTURED depois que OUTRA chave capturava o pedido, com o
   * attemptCount e o declineCode da tentativa alheia. Nao era um campo vazando
   * estado de outra tentativa: eram todos.
   *
   * O contra-argumento que sustentava o desenho antigo — "qual e o estado do meu
   * pagamento?" e a pergunta que o cliente costuma fazer ao repetir — continua
   * valendo, e a resposta e outra rota: quem quer o estado ATUAL consulta o
   * pagamento. Resposta congelada com um campo vivo dentro nao seria congelada.
   *
   * `replay: true` NAO e congelado: vale false na gravacao e true na leitura.
   *
   * O que NAO e ambiguo, e ja esta garantido pelo requestFingerprint: a chave so
   * pode ser reusada para a MESMA requisicao.
   */
  replay: boolean;
}

/**
 * VALORES aceitos do enum, para validar dado vindo do banco.
 *
 * `status in PaymentStatus` NAO serve: `in` percorre a cadeia de prototipos,
 * entao 'toString', 'constructor' e 'valueOf' passariam. Achado 3.1 da segunda
 * rodada de review do PR #56 — e o comentario que eu tinha escrito ali afirmava
 * o contrario, o que e pior que a ausencia de comentario.
 */
const ESTADOS_VALIDOS: ReadonlySet<string> = new Set<string>(Object.values(PaymentStatus));

const NOVA_TENTATIVA_PERMITIDA: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.PENDING,
  PaymentStatus.FAILED,
]);

export class PaymentService {
  private readonly now: () => Date;

  constructor(private readonly deps: PaymentServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Cria a cobranca de um pedido.
   *
   * ORDEM DAS OPERACOES — e a decisao central deste bloco:
   *
   *   1. reivindicar a Idempotency-Key   colide se repetida
   *   2. buscar o pedido e validar valor falha aqui NAO tocou o provedor
   *   3. persistir o rastro              Payment + PaymentTransaction, mesma transacao
   *   4. chamar o provedor               com a chave de idempotencia DELE
   *   5. registrar o desfecho
   *
   * O passo 3 antes do 4 garante rastro no banco ANTES de qualquer efeito
   * externo. Se o processo cair entre 3 e 5, sobra uma PaymentTransaction PENDING
   * sem providerRef — exatamente o rastro que o job do Bloco 6 usa para
   * reconciliar via getCharge. E o motivo pelo qual providerRef e nullable.
   *
   * A ordem inversa pareceria mais simples e produziria o pior caso: cobranca
   * feita, nada no banco, nada para reconciliar.
   */
  async criarPagamento(input: CriarPagamentoInput): Promise<PagamentoCriado> {
    // ---------- 1. claim-first ----------
    const reivindicacao = await this.reivindicarChave(input);
    if ('replay' in reivindicacao) return reivindicacao.replay;
    const registroId = reivindicacao.registroId;

    // ---------- 2. pedido e valor ----------
    const pedido = await this.buscarPedido(input, registroId);

    // O getOne do order permite ADMIN ler pedido de QUALQUER usuario. Como
    // repassamos o token, um token ADMIN traria o pedido de outra pessoa. Esta
    // checagem nao e redundancia: e o que impede criar cobranca em pedido de
    // terceiro. A mensagem e a mesma de "nao encontrado", para nao revelar nada.
    if (pedido.userId !== input.userId) {
      await this.marcarChaveFalhada(registroId);
      throw erroDeDominio('PEDIDO_NAO_ENCONTRADO', 'Pedido nao encontrado');
    }

    const amountCents = await this.validarValor(pedido, registroId);

    // ---------- 3. rastro no banco, antes do efeito externo ----------
    const { payment, transactionId } = await this.persistirTentativa(
      input,
      amountCents,
      registroId,
    );

    // ---------- 4. provedor ----------
    // Chave derivada de paymentId + numero da tentativa, NAO da nossa
    // Idempotency-Key HTTP: a janela de retentativa faz o MESMO Payment cobrar
    // varias vezes, e reusar a nossa chave devolveria a resposta da primeira
    // tentativa — o cliente nunca conseguiria trocar de cartao.
    const chaveDoProvedor = `${payment.id}:${payment.attemptCount}`;

    let resultado;
    try {
      resultado = await this.deps.provider.createCharge({
        amountCents,
        currency: this.deps.currency,
        paymentMethodToken: input.paymentMethodToken,
        idempotencyKey: chaveDoProvedor,
        reference: {
          paymentId: payment.id,
          orderId: payment.orderId,
          attemptCount: payment.attemptCount,
        },
      });
    } catch (erro) {
      await this.tratarFalhaDoProvedor(payment.id, registroId, transactionId, erro);
      throw this.traduzirErroDoProvedor(erro);
    }

    // ---------- 5. desfecho ----------
    return this.registrarDesfecho(payment, transactionId, registroId, resultado);
  }

  // ==========================================================
  // 1. Claim-first
  // ==========================================================

  private async reivindicarChave(
    input: CriarPagamentoInput,
  ): Promise<{ registroId: string } | { replay: PagamentoCriado }> {
    try {
      const registro = await this.deps.prisma.idempotencyRecord.create({
        data: {
          userId: input.userId,
          key: input.idempotencyKey,
          requestFingerprint: this.fingerprintDaRequisicao(input),
        },
      });
      return { registroId: registro.id };
    } catch (erro) {
      if (!this.ehViolacaoDeUnique(erro)) throw erro;
    }

    // Colidiu no @@unique([userId, key]): alguem ja reivindicou esta chave.
    const existente = await this.deps.prisma.idempotencyRecord.findUnique({
      where: { userId_key: { userId: input.userId, key: input.idempotencyKey } },
    });

    if (!existente) {
      // Corrida: o registro sumiu entre o create e o findUnique. Transiente.
      throw erroDeDominio(
        'IDEMPOTENCIA_EM_ANDAMENTO',
        'Requisicao concorrente com a mesma chave; repita',
        true,
      );
    }

    // Achado 4.4 do review: a chave so pode ser reusada para a MESMA requisicao.
    // Sem esta comparacao, reutilizar a chave com outro orderId devolvia
    // silenciosamente o pagamento anterior — o cliente recebia 200 e o pagamento
    // do pedido errado. Vem ANTES dos ramos de status porque vale para qualquer
    // um deles.
    if (existente.requestFingerprint !== this.fingerprintDaRequisicao(input)) {
      throw erroDeDominio(
        'IDEMPOTENCIA_CONFLITANTE',
        'Esta Idempotency-Key ja foi usada com outra requisicao; use uma nova chave',
      );
    }

    if (existente.status === 'COMPLETED') {
      // Caminho normal: devolve o que foi congelado quando a chave finalizou.
      if (existente.completedResponse !== null) {
        const congelada = this.lerCongelada(existente.completedResponse);
        if (congelada !== null) return { replay: { ...congelada, replay: true } };

        // Snapshot PRESENTE mas corrompido: falha explicita, sem consultar o
        // Payment vivo. Eu tinha escolhido degradar aqui, para nao impedir o
        // cliente de descobrir o desfecho — argumento fraco, apontado no review:
        // a resposta degradada pode estar ERRADA sobre dinheiro (o Payment vivo
        // e justamente a fonte do defeito que este bloco corrige), e ela sairia
        // sem nenhuma marca de degradacao. Errar alto e melhor que errar
        // plausivelmente. O fallback para o vivo fica restrito ao legado de
        // verdade, com completedResponse === null.
        console.error(
          '[payment-service] resposta congelada com forma invalida: ' + existente.id,
        );
        throw erroDeDominio(
          'DEPENDENCIA_INDISPONIVEL',
          'Registro de idempotencia com resposta armazenada invalida',
        );
      }

      // Linha anterior a esta migration: nao ha resposta congelada. Reconstroi
      // do Payment VIVO — comportamento antigo, com o defeito antigo (pode
      // devolver o desfecho de outra tentativa no mesmo pedido). Declarado e
      // logado, nunca silencioso. Some quando o backfill rodar e o
      // VALIDATE CONSTRAINT fechar a restricao.
      console.warn(
        '[payment-service] replay de registro legado sem resposta congelada: ' + existente.id,
      );
      // O CHECK idempotency_completed_exige_pagamento garante paymentId nao nulo.
      const payment = await this.deps.prisma.payment.findUnique({
        where: { id: existente.paymentId as string },
        include: { transactions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!payment) {
        throw erroDeDominio(
          'DEPENDENCIA_INDISPONIVEL',
          'Registro de idempotencia aponta para pagamento inexistente',
        );
      }
      return { replay: this.comoResposta(payment, payment.transactions[0]?.failureCode, true) };
    }

    if (existente.status === 'FAILED') {
      throw erroDeDominio(
        'IDEMPOTENCIA_JA_FALHOU',
        'Esta Idempotency-Key ja foi usada numa requisicao que falhou; use uma nova',
      );
    }

    throw erroDeDominio(
      'IDEMPOTENCIA_EM_ANDAMENTO',
      'Outra requisicao com esta Idempotency-Key esta em andamento',
      true,
    );
  }

  // ==========================================================
  // 2. Pedido e valor
  // ==========================================================

  private async buscarPedido(
    input: CriarPagamentoInput,
    registroId: string,
  ): Promise<PedidoDoOrder> {
    try {
      return await this.deps.orderClient.buscarPedido(input.orderId, input.authorization);
    } catch (erro) {
      // Achado 5.1 do segundo review: OrderIndisponivelError passou a carregar
      // `motivo` (ECONNREFUSED, "timeout de 5000ms", "HTTP 503"), mas ninguem
      // consumia o campo. O cliente deixou de receber o detalhe — correto — e o
      // operador tambem, que era justamente o que a correcao queria preservar.
      //
      // Registra orderId e motivo. NAO registra o Authorization nem dados do
      // usuario: log de fluxo financeiro e alvo de leitura ampla.
      if (erro instanceof OrderIndisponivelError) {
        console.error('[payment-service] order-service indisponivel', {
          orderId: input.orderId,
          motivo: erro.motivo,
        });
      }

      const traduzido = this.traduzirErroDoOrder(erro);
      await this.encerrarClaimPreEfeito(registroId, traduzido);
      throw traduzido;
    }
  }

  private async validarValor(pedido: PedidoDoOrder, registroId: string): Promise<number> {
    try {
      return resolverValorDoPedido(pedido);
    } catch (erro) {
      const traduzido =
        erro instanceof PedidoNaoCobravelError
          ? erroDeDominio('PEDIDO_NAO_COBRAVEL', erro.message)
          : erro instanceof ValorDoPedidoInvalidoError
            ? erroDeDominio('VALOR_DO_PEDIDO_INVALIDO', erro.message)
            : erro;
      // await, nao `void`: promessa solta pode nao completar antes do erro subir,
      // e a chave ficaria PROCESSING para sempre.
      await this.encerrarClaimPreEfeito(registroId, traduzido);
      throw traduzido;
    }
  }

  // ==========================================================
  // 3. Persistencia da tentativa
  // ==========================================================

  private async persistirTentativa(
    input: CriarPagamentoInput,
    amountCents: number,
    registroId: string,
  ): Promise<{ payment: Payment; transactionId: string }> {
    const agora = this.now();
    const expiresAt = new Date(agora.getTime() + this.deps.windowMinutes * 60_000);

    try {
      return await this.deps.prisma.$transaction(async (tx) => {
        const existente = await tx.payment.findUnique({
          where: { orderId: input.orderId },
        });

        let payment: Payment;

        if (!existente) {
          payment = await tx.payment.create({
            data: {
              orderId: input.orderId,
              userId: input.userId,
              amountCents,
              currency: this.deps.currency,
              provider: this.deps.provider.name,
              expiresAt,
              attemptCount: 1,
              // PROCESSING desde a criacao, nao PENDING: vamos chamar o provedor
              // em seguida, e o estado tem de refletir "tentativa em voo" ANTES
              // do efeito externo. Nascer PENDING abria a janela do achado 4.1.
              status: PaymentStatus.PROCESSING,
            },
          });
        } else {
          this.assertNovaTentativaPermitida(existente, agora);

          if (existente.amountCents !== amountCents) {
            // O total do pedido mudou entre tentativas. Cobrar valor diferente
            // do que o Payment registrou seria silencioso e grave.
            throw erroDeDominio(
              'VALOR_DO_PEDIDO_INVALIDO',
              `pagamento registrado com ${existente.amountCents} centavos, pedido agora tem ${amountCents}`,
            );
          }

          // COMPARE-AND-SWAP. O assert acima existe para dar MENSAGEM boa; a
          // corretude vem daqui.
          //
          // Achado 4.1 do review do PR #52: sem isto, duas requisicoes com
          // chaves diferentes sobre um Payment em PENDING passavam as duas pelo
          // assert, incrementavam para 2 e 3, e o provedor recebia DUAS chaves
          // derivadas distintas — duas cobrancas para o mesmo pedido. Medido:
          // ["<id>:2", "<id>:3"].
          //
          // O WHERE inclui status E attemptCount. Em READ COMMITTED, a segunda
          // transacao bloqueia no lock da linha e reavalia o predicado depois do
          // commit da primeira; encontrando PROCESSING e o contador ja movido,
          // afeta ZERO linhas.
          const claim = await tx.payment.updateMany({
            where: {
              id: existente.id,
              status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
              attemptCount: existente.attemptCount,
            },
            data: {
              status: PaymentStatus.PROCESSING,
              attemptCount: { increment: 1 },
            },
          });

          if (claim.count !== 1) {
            throw erroDeDominio(
              'TENTATIVA_EM_ANDAMENTO',
              'Outra tentativa para este pedido foi reivindicada em paralelo',
              true,
            );
          }

          payment = await tx.payment.findUniqueOrThrow({ where: { id: existente.id } });
        }

        const transacao = await tx.paymentTransaction.create({
          data: {
            paymentId: payment.id,
            type: TransactionType.AUTHORIZE,
            status: TransactionStatus.PENDING,
            amountCents,
          },
        });

        // Vincula a chave ao pagamento. O CHECK do banco exige paymentId quando
        // o status for COMPLETED, o que acontece no passo 5.
        await tx.idempotencyRecord.update({
          where: { id: registroId },
          data: { paymentId: payment.id },
        });

        return { payment, transactionId: transacao.id };
      });
    } catch (erro) {
      // P2002 AQUI so pode vir de Payment.orderId: e a unica chave unica escrita
      // nesta transacao (paymentTransaction nao tem unique, e o
      // idempotencyRecord e atualizado por id).
      //
      // Cenario: duas requisicoes para o MESMO pedido com Idempotency-Keys
      // DIFERENTES chegam juntas. Ambas passam a reivindicacao (chaves distintas
      // nao colidem), ambas leem payment.findUnique como nulo, e o banco recusa a
      // segunda. E o caso do duplo clique com chave nova por clique — comum, nao
      // exotico. Sem esta traducao o cliente recebia 500.
      //
      // retryable TRUE: nada financeiro aconteceu, entao encerrarClaimPreEfeito
      // LIBERA a claim perdedora e repetir com a MESMA chave funciona de verdade.
      //
      // Este comentario dizia o oposto — retryable false, chave queimada — e
      // sobreviveu a correcao do achado 4.5. Apontado no terceiro review do
      // PR #52: comentario que contradiz o codigo faz a proxima pessoa raciocinar
      // sobre um contrato que nao existe.
      const traduzido = this.ehViolacaoDeUnique(erro)
        ? erroDeDominio(
            'TENTATIVA_EM_ANDAMENTO',
            'Outra tentativa para este pedido foi criada em paralelo; repita',
            true,
          )
        : erro;

      await this.encerrarClaimPreEfeito(registroId, traduzido);
      throw traduzido;
    }
  }

  private assertNovaTentativaPermitida(payment: Payment, agora: Date): void {
    if (payment.status === PaymentStatus.CAPTURED) {
      throw erroDeDominio('PEDIDO_JA_PAGO', 'Este pedido ja foi pago');
    }
    if (payment.status === PaymentStatus.PROCESSING) {
      throw erroDeDominio(
        'TENTATIVA_EM_ANDAMENTO',
        'Ha uma tentativa de pagamento em andamento para este pedido',
        true,
      );
    }
    if (!NOVA_TENTATIVA_PERMITIDA.has(payment.status)) {
      throw erroDeDominio(
        'JANELA_EXPIRADA',
        `Pagamento em ${payment.status}; nao aceita nova tentativa`,
      );
    }
    // Checagem defensiva: o job de expiracao do Bloco 6 pode nao ter rodado.
    if (payment.expiresAt.getTime() <= agora.getTime()) {
      throw erroDeDominio('JANELA_EXPIRADA', 'A janela de pagamento deste pedido expirou');
    }
  }

  // ==========================================================
  // 5. Desfecho
  // ==========================================================

  private async registrarDesfecho(
    payment: Payment,
    transactionId: string,
    registroId: string,
    resultado: Awaited<ReturnType<PaymentProvider['createCharge']>>,
  ): Promise<PagamentoCriado> {
    const novoStatus = mapearEstadoDoProvedor(resultado.state);
    assertTransicao(payment.status, novoStatus);

    this.assertValoresCoerentes(payment, resultado);

    const declineCode = resultado.state === 'DECLINED' ? resultado.declineCode : undefined;

    const atualizado = await this.deps.prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: transactionId },
        data: {
          providerRef: resultado.providerRef,
          // Achado 4.6 do review NAO se aplica aqui, e o compilador prova:
          // `resultado.state === 'CANCELED'` nao compila, porque ChargeResult
          // (retorno de createCharge) so admite SUCCEEDED, PROCESSING e DECLINED.
          // CANCELED existe em ChargeState, que e o conjunto largo usado por
          // getCharge e por webhook — e la a incoerencia apontada e REAL.
          // Registrado como criterio herdado dos Blocos 4 e 6.
          status:
            resultado.state === 'SUCCEEDED'
              ? TransactionStatus.SUCCEEDED
              : resultado.state === 'DECLINED'
                ? TransactionStatus.FAILED
                : TransactionStatus.PENDING,
          failureCode: declineCode,
          failureMessage:
            resultado.state === 'DECLINED' ? resultado.declineMessage : undefined,
        },
      });

      // Captura automatica: quando o provedor captura na propria chamada, as DUAS
      // etapas aconteceram. Registrar so o AUTHORIZE deixaria a trilha incompleta.
      if (resultado.state === 'SUCCEEDED') {
        await tx.paymentTransaction.create({
          data: {
            paymentId: payment.id,
            type: TransactionType.CAPTURE,
            status: TransactionStatus.SUCCEEDED,
            amountCents: resultado.capturedAmountCents,
            providerRef: resultado.providerRef,
          },
        });

        // CAMINHO PRINCIPAL do projeto: sob captura automatica (decisao 10 da
        // fase) o pagamento chega a CAPTURED AQUI, nao pelo webhook. Sem este
        // enqueue nenhum evento e emitido, e um webhook posterior nao conserta
        // porque o WebhookService curto-circuita quando o estado alvo ja e o
        // atual. O `eventId` derivado garante que os dois caminhos nunca
        // produzam duas linhas para a mesma captura.
        await enqueue(
          tx,
          montarEventoDeCaptura(
            {
              paymentId: payment.id,
              orderId: payment.orderId,
              amountCents: payment.amountCents,
              capturedAmountCents: resultado.capturedAmountCents,
              currency: payment.currency,
            },
            new Date(),
          ),
        );
      }

      const p = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: novoStatus,
          capturedAmountCents: resultado.capturedAmountCents,
        },
      });

      // A resposta e congelada na MESMA transacao do desfecho: fora dela
      // existiria um instante com a chave COMPLETED e sem o que devolver no
      // replay. Nesta entrega o invariante e mantido SO pela aplicacao — o
      // CHECK entra na fase contract, quando nao houver escritor antigo.
      await tx.idempotencyRecord.update({
        where: { id: registroId },
        data: {
          status: 'COMPLETED',
          completedResponse: this.paraCongelar(p, declineCode),
        },
      });

      return p;
    });

    return this.comoResposta(atualizado, declineCode, false);
  }

  // ==========================================================
  // Auxiliares
  // ==========================================================

  /**
   * Corpo que vai para `completedResponse`.
   *
   * A lista de campos e FECHADA e usada nas DUAS direcoes — para montar o
   * congelado e para valida-lo na leitura. A versao anterior derivava de
   * comoResposta, o que fazia todo campo novo da resposta da API virar dado em
   * repouso automaticamente, sem ninguem revisar. Apontado no review do
   * PR #56 (achado 5.1), e o revisor tem razao: para dado gravado, explicito
   * vale mais que automatico. Uma lista usada nos dois sentidos continua sendo
   * fonte de verdade unica, e ainda e revisavel.
   *
   * `replay` fica de fora por ser contextual — vale false na gravacao e true na
   * leitura. Congelar `replay: false` e devolve-lo assim seria mentir sobre a
   * natureza da chamada.
   *
   * `declineCode` so entra quando existe: JSON nao representa `undefined`, e
   * gravar a chave com valor nulo mudaria a forma do objeto entre uma tentativa
   * recusada e uma bem-sucedida.
   */
  private paraCongelar(
    payment: Payment,
    declineCode: string | null | undefined,
  ): Prisma.InputJsonObject {
    const corpo: Record<string, unknown> = {
      paymentId: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amountCents: payment.amountCents,
      capturedAmountCents: payment.capturedAmountCents,
      currency: payment.currency,
      attemptCount: payment.attemptCount,
    };
    if (declineCode) corpo.declineCode = declineCode;
    return corpo as Prisma.InputJsonObject;
  }

  /**
   * Le a resposta congelada, RECONSTRUINDO o objeto campo a campo.
   *
   * Nao espalha o JSON: propriedade extra gravada na coluna — por versao futura,
   * por escrita manual, por bug — seria devolvida direto na resposta da API.
   * Achado 3.1 do review do PR #56.
   *
   * Devolve null quando a forma nao confere. Quem chama trata como registro
   * degradado: LOGA e cai no ramo legado. Lancar erro seria pior — impediria um
   * cliente legitimo de descobrir o desfecho do proprio pagamento por causa de
   * uma linha corrompida.
   */
  private lerCongelada(valor: unknown): Omit<PagamentoCriado, 'replay'> | null {
    // Guarda de tipo REDUNDANTE por construcao, mantida de proposito.
    // Nenhum teste consegue isola-la: para array, string ou numero, o acesso
    // `o.paymentId` ja devolve undefined e a checagem de campo abaixo rejeita.
    // A sabotagem X1 removeu esta linha e NADA falhou — resultado esperado, e
    // nao uma lacuna. Ela fica porque declara a intencao e volta a importar se
    // alguem afrouxar as validacoes de campo.
    if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return null;
    const o = valor as Record<string, unknown>;

    const texto = (v: unknown): v is string => typeof v === 'string' && v !== '';
    const inteiro = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

    if (!texto(o.paymentId) || !texto(o.orderId) || !texto(o.currency)) return null;
    if (!inteiro(o.amountCents) || !inteiro(o.capturedAmountCents)) return null;
    if (!inteiro(o.attemptCount)) return null;
    if (!texto(o.status) || !ESTADOS_VALIDOS.has(o.status)) return null;
    if (o.declineCode !== undefined && !texto(o.declineCode)) return null;

    const corpo: Omit<PagamentoCriado, 'replay'> = {
      paymentId: o.paymentId,
      orderId: o.orderId,
      status: o.status as PaymentStatus,
      amountCents: o.amountCents,
      capturedAmountCents: o.capturedAmountCents,
      currency: o.currency,
      attemptCount: o.attemptCount,
    };
    if (o.declineCode !== undefined) corpo.declineCode = o.declineCode;
    return corpo;
  }

  private comoResposta(
    payment: Payment,
    declineCode: string | null | undefined,
    replay: boolean,
  ): PagamentoCriado {
    return {
      paymentId: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amountCents: payment.amountCents,
      capturedAmountCents: payment.capturedAmountCents,
      currency: payment.currency,
      attemptCount: payment.attemptCount,
      declineCode: declineCode ?? undefined,
      replay,
    };
  }

  /**
   * Falha ao chamar o provedor. A acao depende de o dinheiro PODER ter se movido.
   *
   * TRANSIENTE (retryable: timeout, 5xx, rede) — o dinheiro PODE ter sido
   * cobrado: a resposta se perdeu, nao necessariamente o efeito. Nao tocamos em
   * nada. A transacao fica PENDING sem providerRef, que e exatamente o rastro
   * que o job do Bloco 6 procura; e a chave fica PROCESSING, entao o cliente
   * repetindo a MESMA chave recebe IDEMPOTENCIA_EM_ANDAMENTO em vez de abrir uma
   * nova tentativa.
   *
   * Marcar FAILED aqui liberaria nova tentativa, com attemptCount + 1 e portanto
   * chave de provedor NOVA — resultando em SEGUNDA COBRANCA.
   *
   * DETERMINISTICA (token desconhecido, requisicao malformada, credencial
   * invalida) — o provedor recusou antes de mover dinheiro. Marcar FAILED e
   * seguro e libera o cliente para corrigir e tentar de novo. Os TRES estados
   * mudam juntos: Payment, PaymentTransaction e IdempotencyRecord. Deixar o
   * Payment em PROCESSING travaria o pedido, porque nenhuma chave nova passaria
   * pelo CAS.
   *
   * A recuperacao do caso transiente e possivel porque a chave de idempotencia do
   * provedor e DERIVADA (`paymentId:attemptCount`), nao aleatoria: o job pode
   * repetir createCharge com a mesma chave e receber a cobranca ORIGINAL.
   */
  private async tratarFalhaDoProvedor(
    paymentId: string,
    registroId: string,
    transactionId: string,
    erro: unknown,
  ): Promise<void> {
    // ALLOWLIST, nao denylist. Achado 4.2 do review do PR #52.
    //
    // Antes: `erro instanceof PaymentProviderError && erro.retryable` decidia o
    // que era ambiguo. Consequencia: um Error GENERICO — bug no adapter, falha ao
    // desserializar a resposta, qualquer coisa lancada DEPOIS de o provedor ter
    // recebido a cobranca — caia no ramo "deterministico" e era marcado FAILED,
    // liberando nova tentativa com chave de provedor nova: SEGUNDA COBRANCA.
    //
    // Agora so estas duas classes liberam nova tentativa, porque em ambas o
    // provedor recusou a REQUISICAO antes de tocar em dinheiro. Qualquer outro
    // erro, conhecido ou nao, e tratado como financeiramente ambiguo.
    const seguro =
      erro instanceof PaymentProviderError &&
      (erro.name === 'ProviderInvalidRequestError' ||
        erro.name === 'ProviderAuthenticationError');

    if (!seguro) return;

    const codigo = (erro as PaymentProviderError).name;

    // Best effort: se a gravacao da falha tambem falhar, o job do Bloco 6 ainda
    // encontra a transacao PENDING sem providerRef.
    try {
      await this.deps.prisma.$transaction([
        // DESFAZ a reivindicacao do CAS. Levantado no segundo review do PR #52:
        // foi REGRESSAO introduzida pela correcao do achado 4.1.
        //
        // O CAS move o Payment para PROCESSING antes da chamada externa. Numa
        // falha DETERMINISTICA o provedor recusou a requisicao sem tocar em
        // dinheiro, entao o pedido tem de voltar a aceitar tentativa. Sem esta
        // linha, uma chave nova encontrava PROCESSING e recebia
        // TENTATIVA_EM_ANDAMENTO para sempre: pedido impagavel ate a
        // reconciliacao do Bloco 6 — que sequer o encontraria, porque a
        // transacao ja esta FAILED e nao PENDING.
        //
        // Na mesma $transaction que os outros dois updates, de proposito: os
        // tres estados tem de mudar juntos ou nenhum.
        this.deps.prisma.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.FAILED },
        }),
        this.deps.prisma.paymentTransaction.update({
          where: { id: transactionId },
          data: { status: TransactionStatus.FAILED, failureCode: codigo },
        }),
        this.deps.prisma.idempotencyRecord.update({
          where: { id: registroId },
          data: { status: 'FAILED' },
        }),
      ]);
    } catch (secundario) {
      // O erro ORIGINAL continua subindo — e mais informativo para o cliente.
      // Mas a falha secundaria precisa deixar evidencia: sem ela, uma transacao
      // presa em PENDING nao tem nenhum sinal de por que ficou assim.
      console.error('[payment-service] falha ao gravar desfecho de erro do provedor', {
        registroId,
        transactionId,
        causa: secundario instanceof Error ? secundario.message : String(secundario),
      });
    }
  }

  /**
   * Valores devolvidos pelo provedor tem de ser coerentes com o autorizado.
   *
   * Achado 4.3 do review. O CHECK `payment_captured_dentro_do_total` barra
   * captura ACIMA do total, mas captura PARCIAL passa pelo banco: o pagamento
   * viraria CAPTURED com menos dinheiro do que o pedido, sem ninguem notar.
   *
   * Lancar aqui e ANTES de qualquer escrita, entao a transacao permanece PENDING
   * sem providerRef e a chave permanece PROCESSING — o mesmo rastro que o job do
   * Bloco 6 procura. O providerRef vai para o log para que a investigacao tenha
   * onde comecar.
   */
  private assertValoresCoerentes(
    payment: Payment,
    resultado: Awaited<ReturnType<PaymentProvider['createCharge']>>,
  ): void {
    const capturado = resultado.capturedAmountCents;
    const esperado = resultado.state === 'SUCCEEDED' ? payment.amountCents : 0;

    if (capturado === esperado) return;

    console.error('[payment-service] provedor devolveu valores incoerentes', {
      paymentId: payment.id,
      state: resultado.state,
      esperado,
      recebido: capturado,
    });

    throw erroDeDominio(
      'DEPENDENCIA_INDISPONIVEL',
      'Provedor devolveu valor capturado incoerente com o autorizado',
      false,
    );
  }

  /**
   * Encerra a claim de uma falha ANTERIOR ao efeito financeiro.
   *
   * Achado 4.5 do review: antes, QUALQUER falha pre-efeito queimava a chave. Com
   * o order-service fora do ar isso produzia contradicao de contrato — o
   * controller mandava `Retry-After`, e repetir a mesma chave batia em
   * IDEMPOTENCIA_JA_FALHOU. Nada financeiro aconteceu, entao a chave e LIBERADA
   * e a repeticao funciona de verdade.
   *
   * Falha definitiva continua queimando: repetir a mesma requisicao nunca vai
   * funcionar, e liberar so gastaria carga do servico.
   */
  private async encerrarClaimPreEfeito(registroId: string, erro: unknown): Promise<void> {
    if (erro instanceof PaymentDomainError && erro.retryable) {
      await this.liberarChave(registroId);
      return;
    }
    await this.marcarChaveFalhada(registroId);
  }

  private async liberarChave(registroId: string): Promise<void> {
    try {
      await this.deps.prisma.idempotencyRecord.delete({ where: { id: registroId } });
    } catch (erro) {
      // Achado 5.1: catch vazio deixava registro preso sem NENHUMA evidencia
      // operacional. Em fluxo financeiro isso inviabiliza reconciliacao.
      console.error('[payment-service] falha ao liberar claim de idempotencia', {
        registroId,
        causa: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  private async marcarChaveFalhada(registroId: string): Promise<void> {
    try {
      await this.deps.prisma.idempotencyRecord.update({
        where: { id: registroId },
        data: { status: 'FAILED' },
      });
    } catch (erro) {
      console.error('[payment-service] falha ao marcar claim como FAILED', {
        registroId,
        causa: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  /**
   * Impressao da requisicao que reivindicou a chave.
   *
   * So o orderId entra na receita v1. Duas exclusoes deliberadas:
   *
   * - `amountCents` NAO cabe: a claim acontece no passo 1, ANTES de o pedido ser
   *   buscado no passo 2, entao o valor ainda nao existe aqui. A divergencia de
   *   valor entre tentativas ja e barrada em persistirTentativa.
   * - `paymentMethodToken` fica FORA de proposito: trocar de cartao reusando a
   *   mesma chave deve bater como replay. Se o token entrasse, um cliente que
   *   regenera token a cada clique furaria a protecao contra duplo clique, que e
   *   o caso mais comum de uso indevido.
   */
  private fingerprintDaRequisicao(input: CriarPagamentoInput): string {
    return createHash('sha256').update(`v1:${input.orderId}`).digest('hex');
  }

  private ehViolacaoDeUnique(erro: unknown): boolean {
    return (
      erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002'
    );
  }

  private traduzirErroDoOrder(erro: unknown): Error {
    if (erro instanceof OrderNaoEncontradoError) {
      // Mensagem indistinguivel: o order devolve 404 para inexistente E para
      // pedido de outro, para nao revelar existencia.
      return erroDeDominio('PEDIDO_NAO_ENCONTRADO', 'Pedido nao encontrado');
    }
    if (erro instanceof OrderNaoAutorizadoError) {
      return erroDeDominio('NAO_AUTORIZADO', 'Token invalido ou expirado');
    }
    if (erro instanceof OrderIndisponivelError) {
      return erroDeDominio('DEPENDENCIA_INDISPONIVEL', erro.message, true);
    }
    if (erro instanceof OrderRespostaInvalidaError) {
      return erroDeDominio('DEPENDENCIA_INDISPONIVEL', erro.message, false);
    }
    return erro as Error;
  }

  private traduzirErroDoProvedor(erro: unknown): Error {
    if (erro instanceof ProviderInvalidRequestError) {
      return erroDeDominio('REQUISICAO_INVALIDA', erro.message);
    }
    if (erro instanceof PaymentProviderError) {
      return erroDeDominio('DEPENDENCIA_INDISPONIVEL', erro.message, erro.retryable);
    }
    return erro as Error;
  }
}
