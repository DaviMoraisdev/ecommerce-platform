import { MAX_AMOUNT_CENTS } from '../../domain/money';
import {
  CHARGE_STATES,
  ProviderInvalidRequestError,
  type ChargeState,
  type PaymentEventType,
  type WebhookEventPayload,
} from '../payment-provider.port';

/**
 * Formato de fio do evento. snake_case DE PROPOSITO: formato de provedor e
 * estrangeiro, e este modulo e a fronteira onde ele deixa de ser confiavel.
 *
 * Assinatura HMAC valida prova AUTENTICIDADE e INTEGRIDADE dos bytes. Nao prova
 * que o conteudo faz sentido. Um provedor com bug — ou um segredo vazado —
 * poderia entregar bytes assinados com estado inexistente, valor negativo ou id
 * vazio. Tudo abaixo e verificado em runtime; nenhum `as` substitui checagem.
 */
export interface CorpoDeEvento {
  id: string;
  type: string;
  created_at: string | null;
  data: {
    charge_ref: string;
    state: ChargeState;
    captured_amount_cents: number;
    refunded_amount_cents: number;
    decline_code: string | null;
  };
}

const MAX_TAMANHO_TEXTO = 255;

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const TIPOS_SUPORTADOS: ReadonlySet<string> = new Set([
  'payment.succeeded',
  'payment.failed',
  'payment.canceled',
  'refund.succeeded',
]);

const ESTADOS: ReadonlySet<string> = new Set(CHARGE_STATES);

function invalido(mensagem: string): never {
  throw new ProviderInvalidRequestError(`webhook invalido: ${mensagem}`);
}

function texto(valor: unknown, campo: string): string {
  if (typeof valor !== 'string') invalido(`${campo} deve ser string`);
  const limpo = valor.trim();
  if (limpo === '') invalido(`${campo} nao pode ser vazio`);
  if (limpo.length > MAX_TAMANHO_TEXTO) {
    invalido(`${campo} excede ${MAX_TAMANHO_TEXTO} caracteres`);
  }
  return limpo;
}

function textoOpcional(valor: unknown, campo: string): string | undefined {
  if (valor === null || valor === undefined) return undefined;
  return texto(valor, campo);
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

/** Valida a FORMA e os intervalos. Nao decide coerencia semantica. */
export function desserializarEvento(rawBody: Buffer): CorpoDeEvento {
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
  const dados = raiz.data;

  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) {
    invalido('data deve ser um objeto');
  }

  const d = dados as Record<string, unknown>;
  const estado = texto(d.state, 'data.state');
  if (!ESTADOS.has(estado)) invalido(`data.state desconhecido: "${estado}"`);

  return {
    id: texto(raiz.id, 'id'),
    type: texto(raiz.type, 'type'),
    created_at: (raiz.created_at ?? null) as string | null,
    data: {
      charge_ref: texto(d.charge_ref, 'data.charge_ref'),
      state: estado as ChargeState,
      captured_amount_cents: centavos(d.captured_amount_cents, 'data.captured_amount_cents'),
      refunded_amount_cents: centavos(d.refunded_amount_cents, 'data.refunded_amount_cents'),
      decline_code: textoOpcional(d.decline_code, 'data.decline_code') ?? null,
    },
  };
}

/**
 * Traduz para o dominio, exigindo COERENCIA entre tipo de evento e estado.
 *
 * A uniao discriminada de WebhookEventPayload nao permite montar uma variante
 * incoerente, entao a checagem abaixo nao e opcional: sem ela o codigo nao
 * compila. E o tipo obrigando a validacao a existir.
 *
 * Excecao deliberada: 'unsupported' nao exige coerencia nem carrega estado.
 * Nao conhecemos a semantica de um evento que nao tratamos — inventar regra
 * para ele seria pior que ignora-lo.
 */
export function traduzirEvento(corpo: CorpoDeEvento): WebhookEventPayload {
  const base = {
    providerEventId: corpo.id,
    providerRef: corpo.data.charge_ref,
    providerCreatedAt: dataOpcional(corpo.created_at, 'created_at'),
    raw: corpo,
  };

  if (!TIPOS_SUPORTADOS.has(corpo.type)) {
    return { ...base, eventType: 'unsupported' };
  }

  const tipo = corpo.type as Exclude<PaymentEventType, 'unsupported'>;
  const { state, captured_amount_cents: capturado, refunded_amount_cents: reembolsado } = corpo.data;

  function exigirEstado(esperado: ChargeState): void {
    if (state !== esperado) {
      invalido(`evento "${tipo}" exige state "${esperado}", recebeu "${state}"`);
    }
  }

  switch (tipo) {
    case 'payment.succeeded': {
      exigirEstado('SUCCEEDED');
      if (capturado <= 0) invalido('payment.succeeded sem valor capturado');
      if (reembolsado > capturado) invalido('reembolsado acima do capturado');
      return {
        ...base,
        eventType: 'payment.succeeded',
        state: 'SUCCEEDED',
        capturedAmountCents: capturado,
        refundedAmountCents: reembolsado,
      };
    }

    case 'payment.failed': {
      exigirEstado('DECLINED');
      if (capturado !== 0) invalido('payment.failed com valor capturado');
      return {
        ...base,
        eventType: 'payment.failed',
        state: 'DECLINED',
        declineCode: corpo.data.decline_code ?? undefined,
      };
    }

    case 'payment.canceled': {
      exigirEstado('CANCELED');
      if (capturado !== 0) invalido('payment.canceled com valor capturado');
      return { ...base, eventType: 'payment.canceled', state: 'CANCELED' };
    }

    case 'refund.succeeded': {
      exigirEstado('SUCCEEDED');
      if (reembolsado <= 0) invalido('refund.succeeded sem valor reembolsado');
      if (reembolsado > capturado) invalido('reembolsado acima do capturado');
      return {
        ...base,
        eventType: 'refund.succeeded',
        state: 'SUCCEEDED',
        capturedAmountCents: capturado,
        refundedAmountCents: reembolsado,
      };
    }
  }
}
