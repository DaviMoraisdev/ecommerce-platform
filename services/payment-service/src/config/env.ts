import dotenv from 'dotenv';

import type { Currency } from '../domain/money';
import type { ProviderName } from '../providers/payment-provider.port';

dotenv.config({ quiet: true });

export type { Currency };

export interface AppConfig {
  port: number;
  databaseUrl: string;
  defaultCurrency: Currency;
  nodeEnv: NodeEnv;
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
function assertSegredoForte(nome: string, valor: string, nodeEnv: NodeEnv): void {
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
function parseBooleano(raw: string | undefined, nome: string): boolean {
  const valor = raw?.trim();
  if (valor === undefined || valor === '') return false;
  if (valor === 'true') return true;
  if (valor === 'false') return false;
  throw new ConfigError(`${nome} deve ser "true" ou "false", recebeu: ${valor}`);
}

function parseUrlDeServico(
  raw: string,
  nome: string,
  nodeEnv: NodeEnv,
  permitirInseguro: boolean,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${nome} nao e uma URL valida`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${nome} deve usar http ou https, recebeu "${url.protocol}"`);
  }

  // Achado 4.7 do review do PR #52: `new URL` era usado so para VALIDAR, e o
  // retorno era o texto cru. Uma base como `https://order.internal?cluster=a`
  // passava no boot e o cliente montava `.../?cluster=a/orders/<id>` — o caminho
  // caindo DENTRO da query. A falha so apareceria na primeira cobranca.
  //
  // Credenciais embutidas sao recusadas por motivo separado: acabariam em log de
  // configuracao e em mensagem de erro.
  // Achado 3.3 do review do PR #52, elevado a ALTA na terceira rodada.
  //
  // O OrderClient repassa o Authorization do usuario nesta chamada. Em texto
  // claro, quem estiver na rede captura o bearer token e age como o usuario.
  //
  // Exigir https direto quebraria malha com mTLS, onde http:// entre servicos e
  // o padrao — por isso a saida nao e proibir, e OBRIGAR A DECLARAR. O default e
  // fail-closed, e a excecao vira configuracao explicita, verificavel e testada,
  // em vez de uma linha no TECH_DEBT que ninguem executa.
  if (url.protocol === 'http:' && nodeEnv === 'production' && !permitirInseguro) {
    throw new ConfigError(
      `${nome} usa http em producao, e o token do usuario e repassado nesta ` +
        'chamada. Use https, ou declare ORDER_SERVICE_ALLOW_INSECURE=true se o ' +
        'transporte for protegido por mTLS ou malha de servico.',
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${nome} nao pode conter credenciais embutidas`);
  }
  if (url.search !== '') {
    throw new ConfigError(`${nome} nao pode conter query string`);
  }
  if (url.hash !== '') {
    throw new ConfigError(`${nome} nao pode conter fragmento`);
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

/**
 * NODE_ENV e OBRIGATORIO e so aceita a lista fechada. Achado 3.1 do review do
 * PR #52, com um segundo furo encontrado ao corrigi-lo.
 *
 * Furo 1 — o default era `development`, e development ACEITA
 * PAYMENT_PROVIDER=fake. Como o .env.example traz `PAYMENT_PROVIDER=fake`, uma
 * implantacao que copiasse o exemplo e esquecesse NODE_ENV subia com o provedor
 * falso: todo pagamento aprovado, nenhum dinheiro movido. Verificado: o proprio
 * .env deste repositorio NAO define NODE_ENV. "Fail-closed" com default
 * permissivo e so uma frase em comentario.
 *
 * Furo 2 — sem lista fechada, `NODE_ENV=prod` passava. Nao e dev/test, entao
 * `fake` era recusado; mas assertSegredoForte compara com 'production' EXATO,
 * entao a exigencia de 32 caracteres era pulada. Um typo de quatro letras
 * liberava segredo fraco em producao.
 */
const AMBIENTES = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof AMBIENTES)[number];

function parseNodeEnv(raw: string | undefined): NodeEnv {
  const valor = raw?.trim();

  if (!valor) {
    throw new ConfigError(
      'NODE_ENV e obrigatorio. Nao ha default: assumir development aceitaria ' +
        'PAYMENT_PROVIDER=fake, que aprova pagamentos sem movimentar dinheiro. ' +
        'Use development, test ou production.',
    );
  }

  if (!(AMBIENTES as readonly string[]).includes(valor)) {
    throw new ConfigError(
      `NODE_ENV invalido: ${valor}. Use development, test ou production. ` +
        'Valores fora da lista escapam da exigencia de segredo forte, que ' +
        'compara com "production" exato.',
    );
  }

  return valor as NodeEnv;
}

function parseProvider(raw: string, nodeEnv: NodeEnv): ProviderName {
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
  const nodeEnv = parseNodeEnv(source.NODE_ENV);

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
      nodeEnv,
      parseBooleano(source.ORDER_SERVICE_ALLOW_INSECURE, 'ORDER_SERVICE_ALLOW_INSECURE'),
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
