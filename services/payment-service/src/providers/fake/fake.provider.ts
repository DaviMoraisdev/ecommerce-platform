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
  type PaymentEventType,
  type PaymentProvider,
  type ProviderName,
  type ProviderRef,
  type RefundInput,
  type RefundResult,
  type WebhookEventPayload,
  type WebhookRequest,
} from '../payment-provider.port';
import { desserializarEnvelope, traduzirEvento, type CorpoDeEvento } from './fake.wire';
import { comportamentoDoToken } from './fake.tokens';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

const TOLERANCIA_PADRAO_SEGUNDOS = 300;
const TOLERANCIA_MAXIMA_SEGUNDOS = 3600;

/**
 * Maquina de estados da cobranca. FONTE UNICA: cancelCharge e simularTransicao
 * consultam esta tabela, para nao existirem duas regras diferentes no mesmo
 * objeto. Reembolso nao aparece aqui porque nao muda o state — ele move
 * refundedAmountCents dentro de SUCCEEDED.
 */
const TRANSICOES: Record<ChargeState, ReadonlySet<ChargeState>> = {
  PROCESSING: new Set<ChargeState>(['SUCCEEDED', 'DECLINED', 'CANCELED']),
  SUCCEEDED: new Set<ChargeState>([]),
  DECLINED: new Set<ChargeState>([]),
  CANCELED: new Set<ChargeState>([]),
};

function podeTransicionar(de: ChargeState, para: ChargeState): boolean {
  return TRANSICOES[de].has(para);
}

/** Estado interno. Nunca devolvido por referencia — sempre copia. */
interface Cobranca {
  providerRef: ProviderRef;
  /**
   * Correlacao recebida no createCharge. Nao e "dado nosso guardado a mais":
   * e o que o provedor real registra como metadata, e o que torna possivel
   * responder "existe cobranca para esta tentativa?" sem providerRef.
   */
  paymentId: string;
  attemptCount: number;
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
  /** Janela de tolerancia do timestamp, em segundos. Inteiro, 0..3600. */
  toleranciaSegundos?: number;
  /** Relogio injetavel — permite testar a tolerancia sem esperar. */
  now?: () => Date;
}

export interface ConstruirWebhookInput {
  providerRef: ProviderRef;
  eventType: PaymentEventType | string;
  providerEventId?: string;
  providerCreatedAt?: Date | null;

  /**
   * Overrides para testes ADVERSARIAIS. Tipos frouxos de proposito: permitem
   * fabricar corpo incoerente para verificar que a validacao o recusa.
   * Para fluxo coerente, use simularTransicao().
   */
  state?: string;
  capturedAmountCents?: number;
  refundedAmountCents?: number;
  declineCode?: string | null;

  timestampSegundos?: number;
  assinarCom?: string;
}

export interface SimularTransicaoInput {
  providerRef: ProviderRef;
  eventType: Exclude<PaymentEventType, 'unsupported'>;
  refundAmountCents?: number;
  declineCode?: string;
  providerEventId?: string;
  providerCreatedAt?: Date | null;
}

export class FakeProvider implements PaymentProvider {
  readonly name: ProviderName = 'fake';

  /**
   * O fake responde da propria memoria, no mesmo processo: o que ele gravou ja
   * esta visivel na consulta seguinte. Ausencia aqui e definitiva de verdade.
   */
  readonly ausenciaEDefinitiva = true;

  private readonly cobrancas = new Map<ProviderRef, Cobranca>();

  /**
   * Idempotencia guarda o RESULTADO ORIGINAL, nao a referencia da cobranca.
   * Reconstruir do estado atual faria o replay tardio mudar de resposta (ou
   * lancar, se a cobranca tiver sido cancelada) — replay tem de ser estavel.
   */
  private readonly criacaoPorChave = new Map<string, { digital: string; resultado: ChargeResult }>();
  private readonly cancelamentoPorChave = new Map<string, { digital: string; snapshot: ChargeSnapshot }>();
  private readonly reembolsoPorChave = new Map<string, { digital: string; resultado: RefundResult }>();

  private readonly webhookSecret: string;
  private readonly toleranciaSegundos: number;
  private readonly relogio: () => Date;

  private contador = 0;

  constructor(options: FakeProviderOptions) {
    if (!options.webhookSecret || options.webhookSecret.trim() === '') {
      throw new ProviderInvalidRequestError('webhookSecret e obrigatorio');
    }

    const tolerancia = options.toleranciaSegundos ?? TOLERANCIA_PADRAO_SEGUNDOS;
    // Number.isInteger recusa NaN, Infinity e fracionario numa checagem.
    // Sem isso, NaN ou Infinity tornariam "idade > tolerancia" sempre falso e a
    // protecao antirreplay ficaria fail-OPEN — nenhum evento expiraria.
    if (!Number.isInteger(tolerancia) || tolerancia < 0 || tolerancia > TOLERANCIA_MAXIMA_SEGUNDOS) {
      throw new ProviderInvalidRequestError(
        `toleranciaSegundos deve ser inteiro entre 0 e ${TOLERANCIA_MAXIMA_SEGUNDOS}`,
      );
    }

    this.webhookSecret = options.webhookSecret;
    this.toleranciaSegundos = tolerancia;
    this.relogio = options.now ?? (() => new Date());
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

    const digital = this.digital([
      input.amountCents,
      input.currency,
      input.paymentMethodToken,
      input.reference.paymentId,
      input.reference.orderId,
      // Sem isto, reusar a chave com OUTRA tentativa devolveria a cobranca
      // anterior em silencio, em vez de acusar reuso com parametros diferentes.
      input.reference.attemptCount,
    ]);

    const anterior = this.criacaoPorChave.get(input.idempotencyKey);
    if (anterior) {
      if (anterior.digital !== digital) {
        throw new ProviderInvalidRequestError(
          'idempotencyKey reutilizada com parametros diferentes',
        );
      }
      return structuredClone(anterior.resultado);
    }

    const comportamento = comportamentoDoToken(input.paymentMethodToken);
    if (!comportamento) {
      // Sem interpolar o token na mensagem: ele autoriza cobranca.
      throw new ProviderInvalidRequestError('paymentMethodToken desconhecido');
    }

    if (comportamento.kind === 'timeout_apos_cobranca') {
      // A cobranca EXISTE e a chave FICA consumida: o provedor completou e
      // registrou a resposta idempotente; foi o transporte que falhou. Nao
      // consumir a chave aqui simularia um provedor que perde o proprio
      // trabalho, que e justamente o cenario que nao acontece.
      const cobrada = this.registrar(input, { kind: 'succeed' });
      this.criacaoPorChave.set(input.idempotencyKey, {
        digital,
        resultado: structuredClone(this.comoResultado(cobrada)),
      });
      throw this.erroTecnico('unavailable');
    }

    if (comportamento.kind === 'error') {
      // A chave NAO e consumida: nada foi criado, entao retentar deve poder
      // suceder. Consumi-la aqui deixaria o pagamento preso para sempre.
      throw this.erroTecnico(comportamento.error);
    }

    const cobranca = this.registrar(input, comportamento);
    const resultado = this.comoResultado(cobranca);

    this.criacaoPorChave.set(input.idempotencyKey, {
      digital,
      resultado: structuredClone(resultado),
    });

    return structuredClone(resultado);
  }

  // ==========================================================
  // getCharge — reconciliacao (Bloco 6)
  // ==========================================================

  async buscarCobrancaPorTentativa(
    paymentId: string,
    attemptCount: number,
  ): Promise<ChargeSnapshot | null> {
    for (const cobranca of this.cobrancas.values()) {
      if (cobranca.paymentId === paymentId && cobranca.attemptCount === attemptCount) {
        return this.comoSnapshot(cobranca);
      }
    }
    // Ausencia e resposta LEGITIMA, nao erro: significa que a chamada nunca
    // chegou. Lancar ChargeNotFoundError aqui obrigaria o chamador a tratar
    // ausencia como excecao e apagaria a distincao entre "nao existe" e "nao
    // consegui perguntar" — que e a distincao de que o job depende.
    return null;
  }

  async getCharge(providerRef: ProviderRef): Promise<ChargeSnapshot> {
    return this.comoSnapshot(this.exigirCobranca(providerRef));
  }

  // ==========================================================
  // cancelCharge — expiracao da janela (Bloco 6)
  // ==========================================================

  async cancelCharge(input: CancelChargeInput): Promise<ChargeSnapshot> {
    this.exigirChaveIdempotente(input.idempotencyKey);

    const digital = this.digital([input.providerRef]);
    const anterior = this.cancelamentoPorChave.get(input.idempotencyKey);
    if (anterior) {
      if (anterior.digital !== digital) {
        throw new ProviderInvalidRequestError(
          'idempotencyKey reutilizada com parametros diferentes',
        );
      }
      return structuredClone(anterior.snapshot);
    }

    const cobranca = this.exigirCobranca(input.providerRef);

    if (cobranca.state === 'SUCCEEDED') {
      // Dinheiro ja se moveu: desfazer exige refund, nao cancelamento.
      throw new ProviderInvalidRequestError('cobranca capturada nao pode ser cancelada');
    }

    // DECLINED e CANCELED sao terminais: no-op idempotente, para que o job de
    // expiracao nao precise consultar o estado antes de cancelar.
    // cancelCharge e COMANDO idempotente: quando a transicao nao e possivel, faz
    // no-op em vez de lancar, para que o job de expiracao do Bloco 6 nao precise
    // consultar o estado antes de pedir cancelamento.
    //
    // simularTransicao usa a MESMA tabela mas e ESTRITO, porque fabrica evento —
    // emitir payment.canceled para uma cobranca DECLINED produziria fixture
    // incoerente. Diferenca deliberada de tolerancia, nao de regra.
    if (podeTransicionar(cobranca.state, 'CANCELED')) {
      cobranca.state = 'CANCELED';
    }

    const snapshot = this.comoSnapshot(cobranca);
    this.cancelamentoPorChave.set(input.idempotencyKey, {
      digital,
      snapshot: structuredClone(snapshot),
    });

    return structuredClone(snapshot);
  }

  // ==========================================================
  // refund (Bloco 7)
  // ==========================================================

  async refund(input: RefundInput): Promise<RefundResult> {
    this.exigirChaveIdempotente(input.idempotencyKey);
    this.exigirValor(input.amountCents);

    const digital = this.digital([input.providerRef, input.amountCents]);
    const anterior = this.reembolsoPorChave.get(input.idempotencyKey);
    if (anterior) {
      if (anterior.digital !== digital) {
        throw new ProviderInvalidRequestError(
          'idempotencyKey reutilizada com parametros diferentes',
        );
      }
      return structuredClone(anterior.resultado);
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

    this.reembolsoPorChave.set(input.idempotencyKey, {
      digital,
      resultado: structuredClone(resultado),
    });

    return structuredClone(resultado);
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

    const idade = Math.abs(this.agoraEmSegundos() - timestamp);
    if (idade > this.toleranciaSegundos) {
      throw new WebhookSignatureError(
        `evento fora da janela de tolerancia (${idade}s > ${this.toleranciaSegundos}s)`,
      );
    }

    // Assinatura valida prova AUTENTICIDADE dos bytes, nao validade do
    // CONTEUDO. A validacao semantica e obrigatoria e mora em fake.wire.
    return traduzirEvento(desserializarEnvelope(request.rawBody));
  }

  // ==========================================================
  // Afordancias de TESTE — deliberadamente FORA da porta
  // ==========================================================

  /**
   * SIMULA a transicao do provedor: altera o estado interno E devolve o webhook
   * correspondente, coerentes entre si.
   *
   * E o que fluxo de teste deve usar. Depois de simular payment.succeeded, o
   * getCharge reflete SUCCEEDED — sem isso o Fake teria duas fontes de verdade.
   */
  simularTransicao(input: SimularTransicaoInput): WebhookRequest {
    const cobranca = this.exigirCobranca(input.providerRef);

    switch (input.eventType) {
      case 'payment.succeeded': {
        this.exigirTransicao(cobranca.state, 'SUCCEEDED');
        cobranca.state = 'SUCCEEDED';
        cobranca.capturedAmountCents = cobranca.amountCents;
        cobranca.declineCode = undefined;
        cobranca.declineMessage = undefined;
        break;
      }

      case 'payment.failed': {
        this.exigirTransicao(cobranca.state, 'DECLINED');
        cobranca.state = 'DECLINED';
        cobranca.capturedAmountCents = 0;
        cobranca.declineCode = input.declineCode ?? 'generic_decline';
        break;
      }

      case 'payment.canceled': {
        // Antes isto aceitava DECLINED -> CANCELED, criando uma segunda maquina
        // de estados dentro do proprio Fake.
        this.exigirTransicao(cobranca.state, 'CANCELED');
        cobranca.state = 'CANCELED';
        cobranca.capturedAmountCents = 0;
        break;
      }

      case 'refund.succeeded': {
        if (cobranca.state !== 'SUCCEEDED') {
          throw new ProviderInvalidRequestError('so cobranca capturada pode ser reembolsada');
        }
        const disponivel = cobranca.capturedAmountCents - cobranca.refundedAmountCents;
        const valor = input.refundAmountCents ?? disponivel;
        this.exigirValor(valor);
        if (valor > disponivel) {
          throw new ProviderInvalidRequestError('valor do reembolso excede o disponivel');
        }
        cobranca.refundedAmountCents += valor;
        break;
      }
    }

    return this.construirWebhook({
      providerRef: input.providerRef,
      eventType: input.eventType,
      providerEventId: input.providerEventId,
      providerCreatedAt: input.providerCreatedAt,
    });
  }

  /**
   * Fabrica corpo + assinatura. Os defaults sao COERENTES com o eventType — um
   * payment.succeeded nunca sai com state PROCESSING por acidente.
   * Overrides existem para testes adversariais e podem produzir corpo invalido
   * de proposito.
   */
  construirWebhook(input: ConstruirWebhookInput): WebhookRequest {
    const cobranca = this.cobrancas.get(input.providerRef);
    const padrao = this.padroesDoEvento(input.eventType, cobranca);

    const corpo: CorpoDeEvento = {
      id: input.providerEventId ?? `evt_fake_${++this.contador}`,
      type: input.eventType,
      created_at:
        input.providerCreatedAt === null
          ? null
          : (input.providerCreatedAt ?? this.relogio()).toISOString(),
      data: {
        charge_ref: input.providerRef,
        state: (input.state ?? padrao.state) as ChargeState,
        captured_amount_cents: input.capturedAmountCents ?? padrao.capturado,
        refunded_amount_cents: input.refundedAmountCents ?? padrao.reembolsado,
        decline_code: input.declineCode === undefined ? padrao.declineCode : input.declineCode,
      },
    };

    return this.assinarCorpo(corpo, {
      timestampSegundos: input.timestampSegundos,
      assinarCom: input.assinarCom,
    });
  }

  /**
   * Assina um corpo ARBITRARIO com o segredo do Fake.
   * Existe para testar que assinatura valida nao implica conteudo valido: e o
   * unico jeito de fabricar payload autentico e semanticamente invalido.
   */
  assinarCorpo(
    corpo: unknown,
    opts: { timestampSegundos?: number; assinarCom?: string } = {},
  ): WebhookRequest {
    const rawBody = Buffer.isBuffer(corpo)
      ? corpo
      : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), 'utf8');

    const timestamp = opts.timestampSegundos ?? this.agoraEmSegundos();
    const hmac = this.assinarCom(opts.assinarCom ?? this.webhookSecret, timestamp, rawBody);

    return {
      rawBody,
      headers: { [FAKE_SIGNATURE_HEADER]: `t=${timestamp},v1=${hmac}` },
    };
  }

  // ==========================================================
  // Internos
  // ==========================================================

  /**
   * Estrito: usado por simularTransicao. Repetir o estado atual e permitido
   * (replay do mesmo evento); qualquer outro salto fora da tabela lanca.
   */
  private exigirTransicao(de: ChargeState, para: ChargeState): void {
    if (de === para) return;
    if (!podeTransicionar(de, para)) {
      throw new ProviderInvalidRequestError(
        `transicao para ${para} invalida a partir de ${de}`,
      );
    }
  }

  private padroesDoEvento(
    eventType: string,
    cobranca?: Cobranca,
  ): { state: ChargeState; capturado: number; reembolsado: number; declineCode: string | null } {
    const valor = cobranca?.amountCents ?? 0;

    switch (eventType) {
      case 'payment.succeeded':
        return {
          state: 'SUCCEEDED',
          capturado: cobranca?.capturedAmountCents || valor,
          reembolsado: cobranca?.refundedAmountCents ?? 0,
          declineCode: null,
        };

      case 'refund.succeeded': {
        const capturado = cobranca?.capturedAmountCents || valor;
        return {
          state: 'SUCCEEDED',
          capturado,
          // Sem reembolso registrado, assume total — mantem o corpo coerente.
          reembolsado: cobranca?.refundedAmountCents || capturado,
          declineCode: null,
        };
      }

      case 'payment.failed':
        return {
          state: 'DECLINED',
          capturado: 0,
          reembolsado: 0,
          declineCode: cobranca?.declineCode ?? 'generic_decline',
        };

      case 'payment.canceled':
        return { state: 'CANCELED', capturado: 0, reembolsado: 0, declineCode: null };

      default:
        return {
          state: cobranca?.state ?? 'PROCESSING',
          capturado: cobranca?.capturedAmountCents ?? 0,
          reembolsado: cobranca?.refundedAmountCents ?? 0,
          declineCode: cobranca?.declineCode ?? null,
        };
    }
  }

  private registrar(
    input: CreateChargeInput,
    comportamento:
      | { kind: 'succeed' }
      | { kind: 'processing' }
      | { kind: 'decline'; code: string; message: string },
  ): Cobranca {
    const providerRef = `ch_fake_${++this.contador}`;

    const cobranca: Cobranca = {
      providerRef,
      paymentId: input.reference.paymentId,
      attemptCount: input.reference.attemptCount,
      state: 'PROCESSING',
      amountCents: input.amountCents,
      capturedAmountCents: 0,
      refundedAmountCents: 0,
    };

    if (comportamento.kind === 'succeed') {
      cobranca.state = 'SUCCEEDED';
      cobranca.capturedAmountCents = input.amountCents;
    } else if (comportamento.kind === 'decline') {
      cobranca.state = 'DECLINED';
      cobranca.declineCode = comportamento.code;
      cobranca.declineMessage = comportamento.message;
    }

    this.cobrancas.set(providerRef, cobranca);
    return cobranca;
  }

  private comoResultado(cobranca: Cobranca): ChargeResult {
    switch (cobranca.state) {
      case 'SUCCEEDED':
        return {
          providerRef: cobranca.providerRef,
          state: 'SUCCEEDED',
          capturedAmountCents: cobranca.capturedAmountCents,
        };

      case 'PROCESSING':
        return { providerRef: cobranca.providerRef, state: 'PROCESSING', capturedAmountCents: 0 };

      case 'DECLINED':
        return {
          providerRef: cobranca.providerRef,
          state: 'DECLINED',
          capturedAmountCents: 0,
          declineCode: cobranca.declineCode ?? 'generic_decline',
          declineMessage: cobranca.declineMessage,
        };

      case 'CANCELED':
        // Inalcancavel: createCharge nunca cria cobranca cancelada, e o replay
        // devolve o resultado ORIGINAL em vez de reconstruir do estado atual.
        throw new ProviderInvalidRequestError('cobranca ja cancelada');
    }
  }

  private comoSnapshot(cobranca: Cobranca): ChargeSnapshot {
    return {
      providerRef: cobranca.providerRef,
      state: cobranca.state,
      amountCents: cobranca.amountCents,
      capturedAmountCents: cobranca.capturedAmountCents,
      refundedAmountCents: cobranca.refundedAmountCents,
      declineCode: cobranca.declineCode,
    };
  }

  private erroTecnico(tipo: 'unavailable' | 'invalid' | 'authentication'): Error {
    if (tipo === 'unavailable') return new ProviderUnavailableError('provedor indisponivel');
    if (tipo === 'authentication') {
      return new ProviderAuthenticationError('credencial do provedor invalida');
    }
    return new ProviderInvalidRequestError('requisicao invalida');
  }

  private exigirCobranca(providerRef: ProviderRef): Cobranca {
    const cobranca = this.cobrancas.get(providerRef);
    if (!cobranca) throw new ChargeNotFoundError('cobranca nao encontrada no provedor');
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
      if (erro instanceof MoneyError) throw new ProviderInvalidRequestError(erro.message);
      throw erro;
    }
    if (amountCents === 0) {
      throw new ProviderInvalidRequestError('valor deve ser maior que zero');
    }
  }

  private digital(partes: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(partes)).digest('hex');
  }

  /**
   * Relogio validado. Um now() que devolva Invalid Date produziria idade NaN, e
   * "NaN > tolerancia" e falso — a janela antirreplay ficaria fail-OPEN.
   * Falhar aqui e fail-closed: o evento e recusado.
   */
  private agoraEmSegundos(): number {
    const ms = this.relogio().getTime();
    if (!Number.isFinite(ms)) {
      throw new WebhookSignatureError(
        'relogio invalido — impossivel avaliar a janela antirreplay',
      );
    }
    return Math.floor(ms / 1000);
  }

  private lerCabecalhoDeAssinatura(
    headers: Record<string, string | string[] | undefined>,
  ): string {
    // Cabecalho HTTP e case-insensitive; Node normaliza para minusculo, mas um
    // chamador direto pode nao ter normalizado.
    const chave = Object.keys(headers).find((k) => k.toLowerCase() === FAKE_SIGNATURE_HEADER);
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
    if (!t || !v1) throw new WebhookSignatureError('cabecalho de assinatura malformado');

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
}
