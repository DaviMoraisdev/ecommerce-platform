import { MAX_AMOUNT_CENTS } from '../../domain/money';
import {
  CHARGE_STATES,
  ProviderInvalidRequestError,
  type ChargeState,
  type WebhookEventPayload,
} from '../payment-provider.port';

/**
 * Fronteira onde o formato de fio deixa de ser confiavel.
 *
 * Assinatura HMAC valida prova AUTENTICIDADE e INTEGRIDADE dos bytes. Nao prova
 * que o conteudo faz sentido. Tudo abaixo e verificado em runtime; nenhum `as`
 * substitui checagem.
 *
 * ORDEM IMPORTA: valida-se o ENVELOPE primeiro (id, type, created_at) e so
 * depois, se o tipo for suportado, a estrutura de cobranca. Invertido, um evento
 * desconhecido sem bloco de cobranca era recusado como invalido em vez de virar
 * 'unsupported' — e ia para DLQ um evento que deveria ser apenas ignorado.
 */

const MAX_TAMANHO_TEXTO = 255;

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const TIPOS_SUPORTADOS = ['payment.succeeded', 'payment.failed', 'payment.canceled', 'refund.succeeded'] as const;

type TipoSuportado = (typeof TIPOS_SUPORTADOS)[number];

const SUPORTADOS: ReadonlySet<string> = new Set(TIPOS_SUPORTADOS);
const ESTADOS: ReadonlySet<string> = new Set(CHARGE_STATES);

/** Envelope: comum a TODO evento, suportado ou nao. */
export interface EnvelopeDeEvento {
  id: string;
  type: string;
  created_at: string | null;
  /** Nao validado neste nivel: so eventos suportados exigem estrutura. */
  data: unknown;

  /**
   * Objeto original, como o provedor enviou. Vai para o campo raw do inbox.
   * Reconstruir o payload a partir dos campos validados perderia qualquer campo
   * extra que o provedor mande — e o inbox existe justamente para preservar a
   * evidencia integra.
   */
  bruto: unknown;
}

/** Bloco de cobranca: exigido apenas de eventos suportados. */
export interface DadosDeCobranca {
  charge_ref: string;
  state: ChargeState;
  captured_amount_cents: number;
  refunded_amount_cents: number;
  decline_code: string | null;
}

/** Formato completo, usado para CONSTRUIR corpo no FakeProvider. */
export interface CorpoDeEvento {
  id: string;
  type: string;
  created_at: string | null;
  data: DadosDeCobranca;
}

function invalido(mensagem: string): never {
  throw new ProviderInvalidRequestError(`webhook invalido: ${mensagem}`);
}

/**
 * Identificador OPACO. Nao normaliza — recusa espaco nas extremidades.
 *
 * Aplicar trim() aqui faria "evt_1" e " evt_1 " colapsarem no mesmo valor, e
 * providerEventId e a base do unique do inbox: duas mensagens distintas
 * passariam a ser tratadas como duplicata, ou uma correlacionaria com a
 * cobranca errada. O mesmo vale para type e decline_code, que sao valores do
 * provedor comparados e armazenados.
 */
function identificador(valor: unknown, campo: string): string {
  if (typeof valor !== 'string') invalido(`${campo} deve ser string`);
  if (valor === '') invalido(`${campo} nao pode ser vazio`);
  if (valor.trim() === '') invalido(`${campo} nao pode ser somente espacos`);
  if (valor !== valor.trim()) {
    invalido(`${campo} nao pode ter espaco nas extremidades (valor opaco)`);
  }
  if (valor.length > MAX_TAMANHO_TEXTO) {
    invalido(`${campo} excede ${MAX_TAMANHO_TEXTO} caracteres`);
  }
  return valor;
}

function identificadorOpcional(valor: unknown, campo: string): string | null {
  if (valor === null || valor === undefined) return null;
  return identificador(valor, campo);
}

/**
 * Number.isSafeInteger rejeita NaN, Infinity, fracionario e valores acima de
 * 2^53-1 numa unica checagem — nao ha buraco para "numero" estranho passar.
 */
function centavos(valor: unknown, campo: string): number {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor)) {
    invalido(`${campo} deve ser inteiro seguro`);
  }
  if (valor < 0) invalido(`${campo} nao pode ser negativo`);
  if (valor > MAX_AMOUNT_CENTS) invalido(`${campo} acima do teto permitido`);
  return valor;
}

function dataOpcional(valor: unknown, campo: string): Date | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== 'string') invalido(`${campo} deve ser string ISO-8601 ou null`);
  if (!ISO_8601.test(valor)) invalido(`${campo} nao esta em ISO-8601`);

  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) invalido(`${campo} nao e uma data valida`);
  return data;
}

/** Valida SO o envelope. Evento desconhecido para aqui e vira 'unsupported'. */
export function desserializarEnvelope(rawBody: Buffer): EnvelopeDeEvento {
  let bruto: unknown;
  try {
    bruto = JSON.parse(rawBody.toString('utf8'));
  } catch {
    invalido('corpo nao e JSON valido');
  }

  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) {
    invalido('corpo nao e um objeto');
  }

  const raiz = bruto as Record<string, unknown>;

  return {
    id: identificador(raiz.id, 'id'),
    type: identificador(raiz.type, 'type'),
    created_at: (raiz.created_at ?? null) as string | null,
    data: raiz.data,
    bruto: raiz,
  };
}

function validarDadosDeCobranca(data: unknown): DadosDeCobranca {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    invalido('data deve ser um objeto');
  }

  const d = data as Record<string, unknown>;

  const estado = identificador(d.state, 'data.state');
  if (!ESTADOS.has(estado)) invalido(`data.state desconhecido: "${estado}"`);

  return {
    charge_ref: identificador(d.charge_ref, 'data.charge_ref'),
    state: estado as ChargeState,
    captured_amount_cents: centavos(d.captured_amount_cents, 'data.captured_amount_cents'),
    refunded_amount_cents: centavos(d.refunded_amount_cents, 'data.refunded_amount_cents'),
    decline_code: identificadorOpcional(d.decline_code, 'data.decline_code'),
  };
}

/**
 * Traduz para o dominio, exigindo COERENCIA entre tipo, estado e valores.
 *
 * A uniao discriminada de WebhookEventPayload nao permite montar variante
 * incoerente, entao a checagem abaixo nao e opcional: sem ela o codigo nao
 * compila. E o tipo obrigando a validacao a existir.
 */
export function traduzirEvento(envelope: EnvelopeDeEvento): WebhookEventPayload {
  const base = {
    providerEventId: envelope.id,
    providerEventTypeBruto: envelope.type,
    providerCreatedAt: dataOpcional(envelope.created_at, 'created_at'),
    raw: envelope.bruto,
  };

  // Tipo desconhecido para AQUI: nao exigimos estrutura de cobranca, porque o
  // evento pode nao ser sobre cobranca nenhuma.
  if (!SUPORTADOS.has(envelope.type)) {
    return { ...base, eventType: 'unsupported' };
  }

  const tipo = envelope.type as TipoSuportado;
  const dados = validarDadosDeCobranca(envelope.data);
  const { state, captured_amount_cents: capturado, refunded_amount_cents: reembolsado } = dados;

  function exigir(condicao: boolean, mensagem: string): void {
    if (!condicao) invalido(`evento "${tipo}": ${mensagem}`);
  }

  function exigirEstado(esperado: ChargeState): void {
    exigir(state === esperado, `exige state "${esperado}", recebeu "${state}"`);
  }

  const comCobranca = { ...base, providerRef: dados.charge_ref };

  switch (tipo) {
    case 'payment.succeeded': {
      exigirEstado('SUCCEEDED');
      exigir(capturado > 0, 'sem valor capturado');
      exigir(reembolsado <= capturado, 'reembolsado acima do capturado');
      exigir(dados.decline_code === null, 'nao deve trazer decline_code');
      return {
        ...comCobranca,
        eventType: 'payment.succeeded',
        state: 'SUCCEEDED',
        capturedAmountCents: capturado,
        refundedAmountCents: reembolsado,
      };
    }

    case 'payment.failed': {
      exigirEstado('DECLINED');
      exigir(capturado === 0, 'nao deve trazer valor capturado');
      // Reembolso sem captura e impossivel. Antes o campo era silenciosamente
      // descartado, escondendo erro de adapter ou de fixture.
      exigir(reembolsado === 0, 'nao deve trazer valor reembolsado');
      return {
        ...comCobranca,
        eventType: 'payment.failed',
        state: 'DECLINED',
        declineCode: dados.decline_code ?? undefined,
      };
    }

    case 'payment.canceled': {
      exigirEstado('CANCELED');
      exigir(capturado === 0, 'nao deve trazer valor capturado');
      exigir(reembolsado === 0, 'nao deve trazer valor reembolsado');
      exigir(dados.decline_code === null, 'nao deve trazer decline_code');
      return { ...comCobranca, eventType: 'payment.canceled', state: 'CANCELED' };
    }

    case 'refund.succeeded': {
      exigirEstado('SUCCEEDED');
      exigir(capturado > 0, 'sem valor capturado');
      exigir(reembolsado > 0, 'sem valor reembolsado');
      exigir(reembolsado <= capturado, 'reembolsado acima do capturado');
      exigir(dados.decline_code === null, 'nao deve trazer decline_code');
      return {
        ...comCobranca,
        eventType: 'refund.succeeded',
        state: 'SUCCEEDED',
        capturedAmountCents: capturado,
        refundedAmountCents: reembolsado,
      };
    }
  }
}
