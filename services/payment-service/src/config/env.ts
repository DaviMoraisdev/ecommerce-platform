import dotenv from 'dotenv';

import type { Currency } from '../domain/money';
import type { ProviderName } from '../providers/payment-provider.port';

dotenv.config({ quiet: true });

export type { Currency };

export interface AppConfig {
  port: number;
  databaseUrl: string;
  defaultCurrency: Currency;
  nodeEnv: string;
  provider: ProviderName;
  webhookSecret: string;
  jwtSecret: string;
  orderServiceUrl: string;
  orderServiceTimeoutMs: number;
  /**
   * Janela de retentativa (decisao 5 da fase). PROVISORIO: o valor definitivo
   * sai no Bloco 6, com o job de expiracao na frente. Existe agora porque
   * Payment.expiresAt e NOT NULL no schema.
   *
   * Custo de aumentar: estoque fica reservado por mais tempo. Custo de reduzir:
   * cliente com cartao recusado tem menos tempo para tentar outro.
   */
  paymentWindowMinutes: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Valores publicados em arquivos de exemplo do repositorio, ou genericos o
 * bastante para serem chutados. Recusados em QUALQUER ambiente: um segredo que
 * esta no repositorio e um segredo publico. Mesma lista dos outros servicos.
 */
const SEGREDOS_PLACEHOLDER = [
  'troque_este_segredo',
  'dev_jwt_secret_troque_em_producao',
  'sua_chave_secreta_aqui',
  'um_segredo_de_teste',
  'coloque-um-segredo-de-teste-aqui',
  'changeme',
  'change_me',
  'secret',
  'segredo',
  'test',
  'teste',
];

/** 32 caracteres. Recomendado: `openssl rand -hex 32` (64 caracteres). */
const TAMANHO_MINIMO_SEGREDO = 32;

const AMBIENTES_DE_DESENVOLVIMENTO = new Set(['development', 'test']);

function requireEnv(name: string, source: NodeJS.ProcessEnv): string {
  const value = source[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value.trim();
}

/**
 * Placeholder e recusado em qualquer ambiente, porque o cenario de risco e
 * copiar o .env.example e subir localmente. Tamanho minimo so em producao, onde
 * segredo curto ESCOLHIDO pelo operador importa.
 */
function assertSegredoForte(nome: string, valor: string, nodeEnv: string): void {
  if (SEGREDOS_PLACEHOLDER.includes(valor.trim().toLowerCase())) {
    throw new ConfigError(
      `${nome} e um placeholder conhecido, publicado no repositorio. ` +
        'Gere um segredo real: openssl rand -hex 32',
    );
  }

  if (nodeEnv === 'production' && valor.length < TAMANHO_MINIMO_SEGREDO) {
    throw new ConfigError(
      `${nome} tem menos de ${TAMANHO_MINIMO_SEGREDO} caracteres — insuficiente em producao`,
    );
  }
}

/**
 * Sem fallback para localhost, de proposito. O INVENTORY_SERVICE_URL do product
 * tem esse fallback e e divida registrada (Fase 7: "fallback localhost so em
 * dev"): um deploy sem a variavel apontaria silenciosamente para o proprio host.
 */
function parseUrlDeServico(raw: string, nome: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${nome} nao e uma URL valida`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${nome} deve usar http ou https, recebeu "${url.protocol}"`);
  }
  // Normaliza a barra final para o cliente montar caminho sem duplicar "/".
  return raw.replace(/\/+$/, '');
}

function parseTimeout(raw: string | undefined, nome: string, padrao: number): number {
  if (raw === undefined || raw.trim() === '') return padrao;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1 || ms > 60_000) {
    throw new ConfigError(`${nome} invalido: ${raw}. Use inteiro entre 1 e 60000.`);
  }
  return ms;
}

function parseMinutos(raw: string | undefined, nome: string, padrao: number): number {
  if (raw === undefined || raw.trim() === '') return padrao;
  const minutos = Number(raw);
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > 1440) {
    throw new ConfigError(`${nome} invalido: ${raw}. Use inteiro entre 1 e 1440.`);
  }
  return minutos;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PAYMENT_PORT invalida: ${raw}`);
  }
  return port;
}

function parseProvider(raw: string, nodeEnv: string): ProviderName {
  if (raw === 'stripe') {
    return 'stripe';
  }

  if (raw === 'fake') {
    // FAIL-CLOSED. PAYMENT_PROVIDER=fake em producao significaria que qualquer
    // token magico aprova uma cobranca: pagamento sempre bem-sucedido, sem
    // dinheiro nenhum. O Fake e um duble de teste, nao um provedor.
    if (!AMBIENTES_DE_DESENVOLVIMENTO.has(nodeEnv)) {
      throw new ConfigError(
        `PAYMENT_PROVIDER=fake e proibido com NODE_ENV=${nodeEnv}. ` +
          'O provedor Fake aprova cobrancas sem mover dinheiro.',
      );
    }
    return 'fake';
  }

  throw new ConfigError(`PAYMENT_PROVIDER invalido: "${raw}". Use "fake" ou "stripe".`);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (source.NODE_ENV ?? 'development').trim();

  const currency = (source.DEFAULT_CURRENCY ?? 'BRL').trim();
  if (currency !== 'BRL') {
    throw new ConfigError(`DEFAULT_CURRENCY nao suportada: ${currency}`);
  }

  const webhookSecret = requireEnv('PAYMENT_WEBHOOK_SECRET', source);
  assertSegredoForte('PAYMENT_WEBHOOK_SECRET', webhookSecret, nodeEnv);

  const jwtSecret = requireEnv('JWT_SECRET', source);
  assertSegredoForte('JWT_SECRET', jwtSecret, nodeEnv);

  return {
    port: parsePort(requireEnv('PAYMENT_PORT', source)),
    databaseUrl: requireEnv('DATABASE_URL', source),
    defaultCurrency: currency,
    nodeEnv,
    provider: parseProvider(requireEnv('PAYMENT_PROVIDER', source), nodeEnv),
    webhookSecret,
    jwtSecret,
    orderServiceUrl: parseUrlDeServico(
      requireEnv('ORDER_SERVICE_URL', source),
      'ORDER_SERVICE_URL',
    ),
    orderServiceTimeoutMs: parseTimeout(
      source.ORDER_SERVICE_TIMEOUT_MS,
      'ORDER_SERVICE_TIMEOUT_MS',
      5000,
    ),
    paymentWindowMinutes: parseMinutos(
      source.PAYMENT_WINDOW_MINUTES,
      'PAYMENT_WINDOW_MINUTES',
      15,
    ),
  };
}
