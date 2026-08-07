import type { Currency } from '../config/env';

/**
 * Dinheiro no payment-service e SEMPRE inteiro em centavos.
 * Nunca float, nunca string solta: valor sem moeda nao e dinheiro.
 */
export interface Money {
  amountCents: number;
  currency: Currency;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Teto de negocio: R$ 10.000.000,00. Muito abaixo do limite de inteiro seguro. */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

/** Aceita apenas decimal nao-negativo com no maximo 2 casas: "0", "12", "12.9", "12.90". */
const DECIMAL_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Converte um valor decimal para centavos, REJEITANDO qualquer perda de precisao.
 * Aceita string (preferido, vindo de JSON) ou number.
 */
export function toCents(value: string | number): number {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new MoneyError(`Valor monetario nao finito: ${value}`);
  }

  const raw = typeof value === 'number' ? String(value) : value.trim();

  if (!DECIMAL_PATTERN.test(raw)) {
    throw new MoneyError(`Valor monetario invalido: "${raw}"`);
  }

  const [integerPart, fractionPart = ''] = raw.split('.');
  const cents = Number(integerPart) * 100 + Number(fractionPart.padEnd(2, '0'));

  if (cents > MAX_AMOUNT_CENTS) {
    throw new MoneyError(`Valor acima do teto permitido: "${raw}"`);
  }

  return cents;
}

/** Formata centavos de volta para decimal com 2 casas. Uso: log, resposta de API, comparacao. */
export function fromCents(amountCents: number): string {
  assertValidCents(amountCents);
  const units = Math.trunc(amountCents / 100);
  const cents = amountCents % 100;
  return `${units}.${String(cents).padStart(2, '0')}`;
}

/** Invariante central: todo valor manipulado e inteiro, nao-negativo e dentro do teto. */
export function assertValidCents(amountCents: number): void {
  if (!Number.isInteger(amountCents)) {
    throw new MoneyError(`Centavos deve ser inteiro: ${amountCents}`);
  }
  if (amountCents < 0) {
    throw new MoneyError(`Centavos nao pode ser negativo: ${amountCents}`);
  }
  if (amountCents > MAX_AMOUNT_CENTS) {
    throw new MoneyError(`Centavos acima do teto permitido: ${amountCents}`);
  }
}

/** Igualdade de dinheiro exige moeda igual. Comparar BRL com USD e erro, nao false. */
export function equals(a: Money, b: Money): boolean {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Moedas incompativeis: ${a.currency} vs ${b.currency}`);
  }
  return a.amountCents === b.amountCents;
}
