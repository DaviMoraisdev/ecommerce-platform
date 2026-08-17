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
import { erroDeDominio } from '../domain/errors';
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
  /** true quando a resposta veio de replay idempotente, sem novo efeito. */
  replay: boolean;
}

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
        reference: { paymentId: payment.id, orderId: payment.orderId },
      });
    } catch (erro) {
      await this.tratarFalhaDoProvedor(registroId, transactionId, erro);
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
        data: { userId: input.userId, key: input.idempotencyKey },
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

    if (existente.status === 'COMPLETED') {
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
      await this.marcarChaveFalhada(registroId);
      throw this.traduzirErroDoOrder(erro);
    }
  }

  private async validarValor(pedido: PedidoDoOrder, registroId: string): Promise<number> {
    try {
      return resolverValorDoPedido(pedido);
    } catch (erro) {
      // await, nao `void`: promessa solta pode nao completar antes do erro subir,
      // e a chave ficaria PROCESSING para sempre.
      await this.marcarChaveFalhada(registroId);
      if (erro instanceof PedidoNaoCobravelError) {
        throw erroDeDominio('PEDIDO_NAO_COBRAVEL', erro.message);
      }
      if (erro instanceof ValorDoPedidoInvalidoError) {
        throw erroDeDominio('VALOR_DO_PEDIDO_INVALIDO', erro.message);
      }
      throw erro;
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

          payment = await tx.payment.update({
            where: { id: existente.id },
            data: { attemptCount: { increment: 1 } },
          });
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
      await this.marcarChaveFalhada(registroId);

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
      // retryable FALSE de proposito: a chave acabou de ser marcada FAILED, entao
      // repetir a MESMA requisicao daria IDEMPOTENCIA_JA_FALHOU. O cliente precisa
      // de uma Idempotency-Key nova, e a mensagem diz isso.
      if (this.ehViolacaoDeUnique(erro)) {
        throw erroDeDominio(
          'TENTATIVA_EM_ANDAMENTO',
          'Outra tentativa de pagamento para este pedido foi criada em paralelo; repita com uma nova Idempotency-Key',
        );
      }

      throw erro;
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

    const declineCode = resultado.state === 'DECLINED' ? resultado.declineCode : undefined;

    const atualizado = await this.deps.prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: transactionId },
        data: {
          providerRef: resultado.providerRef,
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
      }

      const p = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: novoStatus,
          capturedAmountCents: resultado.capturedAmountCents,
        },
      });

      await tx.idempotencyRecord.update({
        where: { id: registroId },
        data: { status: 'COMPLETED' },
      });

      return p;
    });

    return this.comoResposta(atualizado, declineCode, false);
  }

  // ==========================================================
  // Auxiliares
  // ==========================================================

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
   * seguro e libera o cliente para corrigir e tentar de novo.
   *
   * A recuperacao do caso transiente e possivel porque a chave de idempotencia do
   * provedor e DERIVADA (`paymentId:attemptCount`), nao aleatoria: o job pode
   * repetir createCharge com a mesma chave e receber a cobranca ORIGINAL.
   */
  private async tratarFalhaDoProvedor(
    registroId: string,
    transactionId: string,
    erro: unknown,
  ): Promise<void> {
    const transiente = erro instanceof PaymentProviderError && erro.retryable;
    if (transiente) return;

    const codigo = erro instanceof PaymentProviderError ? erro.name : 'ERRO_DESCONHECIDO';

    // Best effort: se a gravacao da falha tambem falhar, o job do Bloco 6 ainda
    // encontra a transacao PENDING sem providerRef.
    try {
      await this.deps.prisma.$transaction([
        this.deps.prisma.paymentTransaction.update({
          where: { id: transactionId },
          data: { status: TransactionStatus.FAILED, failureCode: codigo },
        }),
        this.deps.prisma.idempotencyRecord.update({
          where: { id: registroId },
          data: { status: 'FAILED' },
        }),
      ]);
    } catch {
      // Silencio deliberado: o erro original e mais informativo que este.
    }
  }

  private async marcarChaveFalhada(registroId: string): Promise<void> {
    try {
      await this.deps.prisma.idempotencyRecord.update({
        where: { id: registroId },
        data: { status: 'FAILED' },
      });
    } catch {
      // idem
    }
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
