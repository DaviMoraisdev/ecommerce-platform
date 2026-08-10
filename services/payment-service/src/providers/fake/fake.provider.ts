import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { assertValidCents, MoneyError } from '../../domain/money';
import {
  ChargeNotFoundError,
  ProviderAuthenticationError,
  ProviderInvalidRequestError,
  ProviderUnavailableError,
  WebhookSignatureError,
  type CancelChargeInput,
  type ChargeResult,
  type ChargeSnapshot,
  type ChargeState,
  type CreateChargeInput,
  type CreateChargeState,
  type PaymentEventType,
  type PaymentProvider,
  type ProviderName,
  type ProviderRef,
  type RefundInput,
  type RefundResult,
  type WebhookEventPayload,
  type WebhookRequest,
} from '../payment-provider.port';
import { comportamentoDoToken } from './fake.tokens';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

const TOLERANCIA_PADRAO_SEGUNDOS = 300;

const TIPOS_SUPORTADOS = new Set<PaymentEventType>([
  'payment.succeeded',
  'payment.failed',
  'payment.canceled',
  'refund.succeeded',
]);

interface Cobranca {
  providerRef: ProviderRef;
  state: ChargeState;
  amountCents: number;
  capturedAmountCents: number;
  refundedAmountCents: number;
  declineCode?: string;
  declineMessage?: string;
}

export interface FakeProviderOptions {
  /** Segredo do HMAC. Mesmo valor que a rota do Bloco 4 vai usar para verificar. */
  webhookSecret: string;
  /** Janela de tolerancia do timestamp, em segundos. */
  toleranciaSegundos?: number;
  /** Relogio injetavel — permite testar a tolerancia sem esperar. */
  now?: () => Date;
}

/**
 * Corpo que o Fake emite no webhook. snake_case DE PROPOSITO: formato de
 * provedor e estrangeiro, e o adapter e quem traduz para o nosso vocabulario.
 */
interface CorpoDeEvento {
  id: string;
  type: string;
  created_at: string | null;
  data: {
    charge_ref: string;
    state: string;
    captured_amount_cents: number;
    refunded_amount_cents: number;
    decline_code: string | null;
  };
}

export interface ConstruirWebhookInput {
  eventType: PaymentEventType | string;
  providerRef: ProviderRef;
  providerEventId?: string;
  providerCreatedAt?: Date | null;
  state?: ChargeState;
  capturedAmountCents?: number;
  refundedAmountCents?: number;
  declineCode?: string | null;
  /** Sobrescreve o timestamp assinado — usado para testar replay/tolerancia. */
  timestampSegundos?: number;
  /** Assina com outro segredo — usado para testar assinatura invalida. */
  assinarCom?: string;
}

export class FakeProvider implements PaymentProvider {
  readonly name: ProviderName = 'fake';

  private readonly cobrancas = new Map<ProviderRef, Cobranca>();
  private readonly refPorChaveIdempotente = new Map<string, { providerRef: ProviderRef; digital: string }>();
  private readonly reembolsoPorChaveIdempotente = new Map<string, { resultado: RefundResult; digital: string }>();

  private readonly webhookSecret: string;
  private readonly toleranciaSegundos: number;
  private readonly now: () => Date;

  private contador = 0;

  constructor(options: FakeProviderOptions) {
    if (!options.webhookSecret || options.webhookSecret.trim() === '') {
      throw new ProviderInvalidRequestError('webhookSecret e obrigatorio');
    }
    this.webhookSecret = options.webhookSecret;
    this.toleranciaSegundos = options.toleranciaSegundos ?? TOLERANCIA_PADRAO_SEGUNDOS;
    this.now = options.now ?? (() => new Date());
  }

  // ==========================================================
  // createCharge
  // ==========================================================

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    this.exigirChaveIdempotente(input.idempotencyKey);
    this.exigirValor(input.amountCents);

    if (input.currency !== 'BRL') {
      throw new ProviderInvalidRequestError('moeda nao suportada');
    }

    // Replay da MESMA chave com os MESMOS parametros devolve a MESMA cobranca.
    // Com parametros DIFERENTES e erro, nao replay: reusar a chave para outra
    // cobranca e bug do cliente, e devolver a anterior esconderia o problema.
    // E o comportamento da Stripe, e o contrato exige que o Fake o reproduza.
    const digital = this.digitalDaCobranca(input);
    const registro = this.refPorChaveIdempotente.get(input.idempotencyKey);
    if (registro) {
      if (registro.digital !== digital) {
        throw new ProviderInvalidRequestError(
          'idempotencyKey reutilizada com parametros diferentes',
        );
      }
      return this.comoResultado(this.exigirCobranca(registro.providerRef));
    }

    const comportamento = comportamentoDoToken(input.paymentMethodToken);
    if (!comportamento) {
      // Sem interpolar o token na mensagem: ele autoriza cobranca.
      throw new ProviderInvalidRequestError('paymentMethodToken desconhecido');
    }

    if (comportamento.kind === 'error') {
      // A chave NAO e consumida: nada foi criado, entao retentar deve poder
      // suceder. Consumi-la aqui deixaria o pagamento preso para sempre.
      throw this.erroTecnico(comportamento.error);
    }

    const cobranca = this.registrar(input, comportamento);
    this.refPorChaveIdempotente.set(input.idempotencyKey, {
      providerRef: cobranca.providerRef,
      digital,
    });

    return this.comoResultado(cobranca);
  }

  // ==========================================================
  // getCharge — reconciliacao (Bloco 6)
  // ==========================================================

  async getCharge(providerRef: ProviderRef): Promise<ChargeSnapshot> {
    return { ...this.exigirCobranca(providerRef) };
  }

  // ==========================================================
  // cancelCharge — expiracao da janela (Bloco 6)
  // ==========================================================

  async cancelCharge(input: CancelChargeInput): Promise<ChargeSnapshot> {
    this.exigirChaveIdempotente(input.idempotencyKey);
    const cobranca = this.exigirCobranca(input.providerRef);

    if (cobranca.state === 'SUCCEEDED') {
      // Dinheiro ja se moveu: desfazer exige refund, nao cancelamento.
      throw new ProviderInvalidRequestError('cobranca capturada nao pode ser cancelada');
    }

    // DECLINED e CANCELED sao terminais: no-op idempotente, para que o job de
    // expiracao nao precise consultar o estado antes de cancelar.
    if (cobranca.state === 'PROCESSING') {
      cobranca.state = 'CANCELED';
    }

    return { ...cobranca };
  }

  // ==========================================================
  // refund (Bloco 7)
  // ==========================================================

  async refund(input: RefundInput): Promise<RefundResult> {
    this.exigirChaveIdempotente(input.idempotencyKey);
    this.exigirValor(input.amountCents);

    const digital = this.digitalDoReembolso(input);
    const anterior = this.reembolsoPorChaveIdempotente.get(input.idempotencyKey);
    if (anterior) {
      if (anterior.digital !== digital) {
        throw new ProviderInvalidRequestError(
          'idempotencyKey reutilizada com parametros diferentes',
        );
      }
      return { ...anterior.resultado };
    }

    const cobranca = this.exigirCobranca(input.providerRef);

    if (cobranca.state !== 'SUCCEEDED') {
      throw new ProviderInvalidRequestError('so cobranca capturada pode ser reembolsada');
    }

    const disponivel = cobranca.capturedAmountCents - cobranca.refundedAmountCents;
    if (input.amountCents > disponivel) {
      throw new ProviderInvalidRequestError('valor do reembolso excede o disponivel');
    }

    cobranca.refundedAmountCents += input.amountCents;

    const resultado: RefundResult = {
      providerRefundRef: `re_fake_${++this.contador}`,
      state: 'SUCCEEDED',
      amountCents: input.amountCents,
    };

    this.reembolsoPorChaveIdempotente.set(input.idempotencyKey, { resultado, digital });
    return { ...resultado };
  }

  // ==========================================================
  // verifyWebhook (Bloco 4)
  // ==========================================================

  verifyWebhook(request: WebhookRequest): WebhookEventPayload {
    const assinatura = this.lerCabecalhoDeAssinatura(request.headers);
    const { timestamp, hmacRecebido } = this.decompor(assinatura);

    // Assinatura ANTES da tolerancia: sem assinatura valida, o remetente nao
    // deve conseguir descobrir qual e a janela de tempo aceita.
    const esperado = this.assinar(timestamp, request.rawBody);
    if (!this.iguaisEmTempoConstante(esperado, hmacRecebido)) {
      throw new WebhookSignatureError('assinatura nao confere');
    }

    const agoraSegundos = Math.floor(this.now().getTime() / 1000);
    const idade = Math.abs(agoraSegundos - timestamp);
    if (idade > this.toleranciaSegundos) {
      throw new WebhookSignatureError(
        `evento fora da janela de tolerancia (${idade}s > ${this.toleranciaSegundos}s)`,
      );
    }

    return this.traduzir(this.desserializar(request.rawBody));
  }

  // ==========================================================
  // Afordancia de TESTE — deliberadamente FORA da porta
  // ==========================================================

  /**
   * Produz corpo cru + cabecalho de assinatura validos. O Fake nao entrega o
   * webhook: quem chama decide se invoca o handler direto (unit) ou faz o POST
   * na rota (e2e). Isso mantem o Fake livre de cliente HTTP e de timer, e o
   * teste deterministico.
   *
   * Nao esta na porta porque nao e capacidade de provedor — a Stripe nao tem
   * equivalente em runtime (o analogo dela e a CLI).
   */
  construirWebhook(input: ConstruirWebhookInput): WebhookRequest {
    const cobranca = this.cobrancas.get(input.providerRef);

    const corpo: CorpoDeEvento = {
      id: input.providerEventId ?? `evt_fake_${++this.contador}`,
      type: input.eventType,
      created_at:
        input.providerCreatedAt === null
          ? null
          : (input.providerCreatedAt ?? this.now()).toISOString(),
      data: {
        charge_ref: input.providerRef,
        state: input.state ?? cobranca?.state ?? 'PROCESSING',
        captured_amount_cents:
          input.capturedAmountCents ?? cobranca?.capturedAmountCents ?? 0,
        refunded_amount_cents:
          input.refundedAmountCents ?? cobranca?.refundedAmountCents ?? 0,
        decline_code: input.declineCode ?? cobranca?.declineCode ?? null,
      },
    };

    const rawBody = Buffer.from(JSON.stringify(corpo), 'utf8');
    const timestamp = input.timestampSegundos ?? Math.floor(this.now().getTime() / 1000);
    const segredo = input.assinarCom ?? this.webhookSecret;
    const hmac = this.assinarCom(segredo, timestamp, rawBody);

    return {
      rawBody,
      headers: { [FAKE_SIGNATURE_HEADER]: `t=${timestamp},v1=${hmac}` },
    };
  }

  // ==========================================================
  // Internos
  // ==========================================================

  /**
   * Digital dos parametros que definem a cobranca. Usada para detectar reuso de
   * chave com corpo diferente. Nao inclui a propria chave — ela e o indice.
   */
  private digitalDaCobranca(input: CreateChargeInput): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          input.amountCents,
          input.currency,
          input.paymentMethodToken,
          input.reference.paymentId,
          input.reference.orderId,
        ]),
      )
      .digest('hex');
  }

  private digitalDoReembolso(input: RefundInput): string {
    return createHash('sha256')
      .update(JSON.stringify([input.providerRef, input.amountCents]))
      .digest('hex');
  }

  private registrar(
    input: CreateChargeInput,
    comportamento: { kind: 'succeed' } | { kind: 'processing' } | { kind: 'decline'; code: string; message: string },
  ): Cobranca {
    const providerRef = `ch_fake_${++this.contador}`;

    const base: Cobranca = {
      providerRef,
      state: 'PROCESSING',
      amountCents: input.amountCents,
      capturedAmountCents: 0,
      refundedAmountCents: 0,
    };

    if (comportamento.kind === 'succeed') {
      base.state = 'SUCCEEDED';
      base.capturedAmountCents = input.amountCents;
    } else if (comportamento.kind === 'decline') {
      base.state = 'DECLINED';
      base.declineCode = comportamento.code;
      base.declineMessage = comportamento.message;
    }

    this.cobrancas.set(providerRef, base);
    return base;
  }

  private comoResultado(cobranca: Cobranca): ChargeResult {
    if (cobranca.state === 'CANCELED') {
      throw new ProviderInvalidRequestError('cobranca ja cancelada');
    }

    const resultado: ChargeResult = {
      providerRef: cobranca.providerRef,
      state: cobranca.state as CreateChargeState,
      capturedAmountCents: cobranca.capturedAmountCents,
    };

    if (cobranca.state === 'DECLINED') {
      resultado.declineCode = cobranca.declineCode;
      resultado.declineMessage = cobranca.declineMessage;
    }

    return resultado;
  }

  private erroTecnico(tipo: 'unavailable' | 'invalid' | 'authentication'): Error {
    if (tipo === 'unavailable') {
      return new ProviderUnavailableError('provedor indisponivel');
    }
    if (tipo === 'authentication') {
      return new ProviderAuthenticationError('credencial do provedor invalida');
    }
    return new ProviderInvalidRequestError('requisicao invalida');
  }

  private exigirCobranca(providerRef: ProviderRef): Cobranca {
    const cobranca = this.cobrancas.get(providerRef);
    if (!cobranca) {
      throw new ChargeNotFoundError('cobranca nao encontrada no provedor');
    }
    return cobranca;
  }

  private exigirChaveIdempotente(chave: string): void {
    if (!chave || chave.trim() === '') {
      throw new ProviderInvalidRequestError('idempotencyKey e obrigatoria');
    }
  }

  private exigirValor(amountCents: number): void {
    try {
      assertValidCents(amountCents);
    } catch (erro) {
      if (erro instanceof MoneyError) {
        throw new ProviderInvalidRequestError(erro.message);
      }
      throw erro;
    }
    if (amountCents === 0) {
      throw new ProviderInvalidRequestError('valor deve ser maior que zero');
    }
  }

  private lerCabecalhoDeAssinatura(
    headers: Record<string, string | string[] | undefined>,
  ): string {
    // Cabecalho HTTP e case-insensitive; Node normaliza para minusculo, mas um
    // chamador direto pode nao ter normalizado.
    const chave = Object.keys(headers).find(
      (k) => k.toLowerCase() === FAKE_SIGNATURE_HEADER,
    );
    const bruto = chave ? headers[chave] : undefined;
    const valor = Array.isArray(bruto) ? bruto[0] : bruto;

    if (!valor || valor.trim() === '') {
      throw new WebhookSignatureError('cabecalho de assinatura ausente');
    }
    return valor;
  }

  private decompor(assinatura: string): { timestamp: number; hmacRecebido: string } {
    const partes = new Map<string, string>();
    for (const item of assinatura.split(',')) {
      const separador = item.indexOf('=');
      if (separador <= 0) continue;
      partes.set(item.slice(0, separador).trim(), item.slice(separador + 1).trim());
    }

    const t = partes.get('t');
    const v1 = partes.get('v1');
    if (!t || !v1) {
      throw new WebhookSignatureError('cabecalho de assinatura malformado');
    }

    const timestamp = Number(t);
    if (!Number.isInteger(timestamp) || timestamp <= 0) {
      throw new WebhookSignatureError('timestamp da assinatura invalido');
    }

    return { timestamp, hmacRecebido: v1 };
  }

  private assinar(timestamp: number, rawBody: Buffer): string {
    return this.assinarCom(this.webhookSecret, timestamp, rawBody);
  }

  private assinarCom(segredo: string, timestamp: number, rawBody: Buffer): string {
    // O timestamp entra DENTRO do material assinado. Se ficasse so no cabecalho,
    // um atacante poderia reenviar o corpo com timestamp novo e passar pela
    // janela de tolerancia — replay attack.
    const material = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
    return createHmac('sha256', segredo).update(material).digest('hex');
  }

  private iguaisEmTempoConstante(esperado: string, recebido: string): boolean {
    const a = Buffer.from(esperado, 'utf8');
    const b = Buffer.from(recebido, 'utf8');

    // timingSafeEqual exige mesmo tamanho. Comparar tamanho antes nao vaza
    // segredo: o comprimento do hex de um SHA-256 e publico e fixo.
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  }

  private desserializar(rawBody: Buffer): CorpoDeEvento {
    let corpo: unknown;
    try {
      corpo = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new ProviderInvalidRequestError('corpo do webhook nao e JSON valido');
    }

    if (typeof corpo !== 'object' || corpo === null) {
      throw new ProviderInvalidRequestError('corpo do webhook nao e um objeto');
    }

    const c = corpo as Partial<CorpoDeEvento>;
    if (typeof c.id !== 'string' || typeof c.type !== 'string' || typeof c.data !== 'object' || c.data === null) {
      throw new ProviderInvalidRequestError('corpo do webhook sem os campos obrigatorios');
    }

    return corpo as CorpoDeEvento;
  }

  private traduzir(corpo: CorpoDeEvento): WebhookEventPayload {
    const tipo = TIPOS_SUPORTADOS.has(corpo.type as PaymentEventType)
      ? (corpo.type as PaymentEventType)
      : 'unsupported';

    const criadoEm = corpo.created_at ? new Date(corpo.created_at) : null;

    return {
      providerEventId: corpo.id,
      eventType: tipo,
      providerRef: corpo.data.charge_ref,
      // Data invalida vira null: melhor cair na politica fail-closed do Bloco 4
      // do que carregar um Invalid Date para dentro do dominio.
      providerCreatedAt:
        criadoEm && !Number.isNaN(criadoEm.getTime()) ? criadoEm : null,
      state: corpo.data.state as ChargeState,
      capturedAmountCents: corpo.data.captured_amount_cents,
      refundedAmountCents: corpo.data.refunded_amount_cents,
      declineCode: corpo.data.decline_code ?? undefined,
      raw: corpo,
    };
  }
}
