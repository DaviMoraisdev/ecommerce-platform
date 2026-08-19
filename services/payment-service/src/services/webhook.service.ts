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
  /**
   * Condicao possivelmente TRANSITORIA: o evento nao pode ser aplicado agora,
   * mas pode vir a ser. A rota traduz em 5xx para o provedor retentar. Marcar
   * como terminal e responder 200 perderia o efeito financeiro para sempre.
   */
  retentavel?: boolean;
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
/**
 * Correspondencia EXATA so funciona para nomes curtos e ambiguos, onde busca
 * por substring geraria falso positivo: `company` contem "pan", `phone_number`
 * contem "number".
 */
const NOMES_EXATOS = new Set([
  'pan', 'cvv', 'cvc', 'iban', 'card', 'number', 'token', 'secret',
  'password', 'senha',
]);

/**
 * Raizes buscadas por SUBSTRING na chave normalizada. Normalizar (minusculas
 * e remover tudo que nao e alfanumerico) faz `access_token`, `accessToken`,
 * `x-api-key` e `API_KEY` colapsarem na mesma forma. Achado 3.1 do review:
 * antes era `has(chave.toLowerCase())`, e todas essas variantes escapavam.
 */
const RAIZES_SENSIVEIS = [
  'token', 'secret', 'password', 'senha', 'authorization', 'apikey',
  'privatekey', 'cardnumber', 'creditcard', 'accountnumber',
];

function ehSensivel(chave: string): boolean {
  const normalizada = chave.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (NOMES_EXATOS.has(normalizada)) return true;
  return RAIZES_SENSIVEIS.some((raiz) => normalizada.includes(raiz));
}
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
      saida[chave] = ehSensivel(chave) ? '[redigido]' : sanitizar(v, profundidade + 1);
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
   * pendente e recuperavel.
   *
   * LIMITE CONHECIDO (achado 5.1 do review): isto e REGISTRO DURAVEL ANTES DO
   * EFEITO, e NAO claim exclusivo. O `create` do inbox acontece FORA da
   * transacao que altera pagamento, trilha e status final — duas entregas
   * concorrentes do mesmo evento podem ambas prosseguir. O dinheiro fica
   * protegido pelo compare-and-swap; a TRILHA pode ficar incorreta, porque a
   * perdedora do CAS sobrescreve o status da linha. Claim exclusivo exige valor
   * novo no enum ou coluna de lease, ou seja migracao: registrado para o Bloco 6.
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
      await this.deps.prisma.webhookEvent.update({
        where: { id: registroId },
        data: { lastError: 'providerRef ainda desconhecido' },
      });
      return {
        status: WebhookStatus.RECEIVED,
        motivo: 'providerRef ainda desconhecido',
        retentavel: true,
      };
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
      // ACHADO 4.2 do review: perder o CAS nao prova que o evento e obsoleto.
      // Recarrega e refaz a decisao sobre o estado REAL.
      const atual = await this.deps.prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });

      // Outro evento ja aplicou o MESMO desfecho: nao houve recusa.
      if (novoStatus === atual.status) {
        return this.encerrar(registroId, WebhookStatus.PROCESSED);
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
