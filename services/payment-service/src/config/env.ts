import dotenv from 'dotenv';

dotenv.config({ quiet: true });

import type { Currency } from '../domain/money';


export interface AppConfig {
  port: number;
  databaseUrl: string;
  defaultCurrency: Currency;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireEnv(name: string, source: NodeJS.ProcessEnv): string {
  const value = source[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value.trim();
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PAYMENT_PORT invalida: ${raw}`);
  }
  return port;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const currency = (source.DEFAULT_CURRENCY ?? 'BRL').trim();
  if (currency !== 'BRL') {
    throw new ConfigError(`DEFAULT_CURRENCY nao suportada: ${currency}`);
  }

  return {
    port: parsePort(requireEnv('PAYMENT_PORT', source)),
    databaseUrl: requireEnv('DATABASE_URL', source),
    defaultCurrency: currency,
  };
}
