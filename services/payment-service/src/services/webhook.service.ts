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
import type { WebhookEventPayload } from '../providers/payment-provider.port';

export interface WebhookServiceDeps {
  prisma: PrismaClient;
}

export interface ResultadoDeWebhook {
  status: WebhookStatus;
  motivo?: string;
}

/**
 * Sanitizacao em ESCRITA, por DENYLIST — e nao por allowlist.
 *
 * Reversao consciente do que eu defendi antes: allowlist e a regra quando se
 * conhece a forma do dado. Aqui o inbox existe justamente para preservar campos
 * que o provedor mande e nos nao conhecamos (fake.wire guarda `bruto` por esse
 * motivo). Allowlist apagaria exatamente a evidencia que da valor a tabela.
 * Entao: preserva tudo, redige o que sabemos ser sensivel, e limita
 * profundidade e tamanho de array para o payload nao virar vetor de DoS.
 */
const CHAVES_SENSIVEIS = new Set([
  'card', 'pan', 'number', 'cvv', 'cvc', 'secret', 'client_secret',
  'password', 'authorization', 'token', 'api_key',
]);
const PROFUNDIDADE_MAXIMA = 8;
const ITENS_MAXIMOS = 100;

function sanitizar(valor: unknown, profundidade = 0): unknown {
  if (profundidade > PROFUNDIDADE_MAXIMA) return '[profundidade excedida]';
  if (Array.isArray(valor)) {
    return valor.slice(0, ITENS_MAXIMOS).map((item) => sanitizar(item, profundidade + 1));
  }
  if (valor !== null && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chave, v] of Object.entries(valor)) {
      saida[chave] = CHAVES_SENSIVEIS.has(chave.toLowerCase())
        ? '[redigido]'
        : sanitizar(v, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

/**
 * Mensagem gravada em lastError. NUNCA a mensagem original: erro de Prisma
 * carrega nome de tabela e coluna, e o inbox e lido em triagem operacional.
 */
function mensagemSegura(erro: unknown): string {
  if (erro instanceof Prisma.PrismaClientKnownRequestError) {
    return `falha de banco (${erro.code})`;
  }
  return 'falha inesperada no processamento do webhook';
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
   * pendente e recuperavel — mesmo claim-before-effects da Fase 4, com a trava
   * sendo constraint do Postgres em vez de SET NX no Redis. A vantagem aqui e
   * que trava e efeito cabem na MESMA transacao.
   */
  async processar(
    providerName: string,
    evento: WebhookEventPayload,
  ): Promise<ResultadoDeWebhook> {
    const registro = await this.registrar(providerName, evento);
    if ('duplicata' in registro) return { status: registro.duplicata };

    try {
      return await this.decidirEAplicar(registro.id, evento);
    } catch (erro) {
      await this.deps.prisma.webhookEvent.update({
        where: { id: registro.id },
        data: {
          status: WebhookStatus.FAILED,
          attempts: { increment: 1 },
          lastError: mensagemSegura(erro),
        },
      });
      throw erro;
    }
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
          payload: sanitizar(evento.raw) as Prisma.InputJsonValue,
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
      if (
        existente.status === WebhookStatus.PROCESSED ||
        existente.status === WebhookStatus.IGNORED
      ) {
        return { duplicata: existente.status };
      }

      // RECEIVED/FAILED significa que o efeito NUNCA aconteceu — queda entre
      // gravar e aplicar. Tratar isso como duplicata prenderia o pagamento
      // para sempre por uma falha transitoria.
      await this.deps.prisma.webhookEvent.update({
        where: { id: existente.id },
        data: { attempts: { increment: 1 } },
      });
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
      return this.encerrar(registroId, WebhookStatus.IGNORED, 'providerRef desconhecido');
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

    const novoStatus = mapearEstadoDoProvedor(evento.state);

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
        where: { id: payment.id, status: payment.status },
        data: {
          status: novoStatus,
          ...(evento.eventType === 'payment.succeeded'
            ? { capturedAmountCents: evento.capturedAmountCents }
            : {}),
        },
      });
      if (count === 0) return false;

      await this.escreverTrilha(tx, payment, transacao, evento);

      await tx.webhookEvent.update({
        where: { id: registroId },
        data: { status: WebhookStatus.PROCESSED, processedAt: new Date(), lastError: null },
      });
      return true;
    });

    if (!aplicado) {
      return this.encerrar(
        registroId,
        WebhookStatus.IGNORED,
        'estado do pagamento mudou durante o processamento',
      );
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

  private async aplicarReembolso(
    registroId: string,
    evento: EventoDeReembolso,
    payment: Payment,
  ): Promise<ResultadoDeWebhook> {
    if (payment.status !== PaymentStatus.CAPTURED) {
      return this.encerrar(
        registroId,
        WebhookStatus.IGNORED,
        `reembolso exige CAPTURED, status atual ${payment.status}`,
      );
    }

    // O evento carrega o TOTAL reembolsado; a linha da trilha registra ESTA
    // movimentacao. A diferenca e o que efetivamente se moveu agora.
    const delta = evento.refundedAmountCents - payment.refundedAmountCents;
    if (delta <= 0) {
      return this.encerrar(registroId, WebhookStatus.PROCESSED);
    }

    const aplicado = await this.deps.prisma.$transaction(async (tx) => {
      // CAS sobre o VALOR, nao sobre o status: CAPTURED e terminal e nao muda
      // (decisao 9 da fase — reembolso e aritmetica, nao transicao).
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, refundedAmountCents: payment.refundedAmountCents },
        data: { refundedAmountCents: evento.refundedAmountCents },
      });
      if (count === 0) return false;

      await tx.paymentTransaction.create({
        data: {
          paymentId: payment.id,
          type: TransactionType.REFUND,
          status: TransactionStatus.SUCCEEDED,
          amountCents: delta,
          providerRef: evento.providerRef,
        },
      });
      await tx.webhookEvent.update({
        where: { id: registroId },
        data: { status: WebhookStatus.PROCESSED, processedAt: new Date(), lastError: null },
      });
      return true;
    });

    if (!aplicado) {
      return this.encerrar(
        registroId,
        WebhookStatus.IGNORED,
        'refundedAmountCents mudou durante o processamento',
      );
    }
    return { status: WebhookStatus.PROCESSED };
  }

  private async encerrar(
    registroId: string,
    status: WebhookStatus,
    motivo?: string,
  ): Promise<ResultadoDeWebhook> {
    await this.deps.prisma.webhookEvent.update({
      where: { id: registroId },
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
