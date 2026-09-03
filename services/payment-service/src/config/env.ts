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
  /**
   * Teto de tentativas do inbox de webhook (Bloco 6c). Ao atingi-lo, o evento
   * vai para QUARANTINED e a rota passa a responder 200 — o que encerra o laco
   * de reentrega do provedor.
   *
   * Vive no AppConfig, e nao em process.env solto como os knobs do relay, pelo
   * GATILHO registrado no TECH_DEBT ("reavaliar se algum passar a ter efeito
   * operacional relevante"): este decide quando o servico PARA DE TENTAR
   * aplicar evento financeiro. Aumentar custa reprocessar mais vezes um evento
   * que nunca vai passar; reduzir arrisca desistir de falha transitoria que se
   * resolveria sozinha.
   */
  /**
   * Liga a varredura de EXPIRACAO (Bloco 6e). Default DESLIGADA.
   *
   * A varredura produz `Payment.EXPIRED`, e a saga ainda nao recebe esse
   * desfecho (o evento e o binding entram no 6f). Ligada antes disso, cada
   * pagamento expirado vira um registro SEM evento de outbox — e acrescentar
   * o produtor depois so cobre transicoes NOVAS, deixando um passivo
   * historico que nenhum backfill automatico recupera.
   */
  expiracaoHabilitada: boolean;
  /** Derivado da flag. Ver `varredurasPorCiclo`. */
  varredurasPorCiclo: number;
  webhookMaxAttempts: number;
  /**
   * Idade a partir da qual um evento AINDA inaplicavel vai para QUARANTINED
   * (Bloco 6c). Atende a populacao que o teto NAO alcanca: o desfecho
   * `retentavel` (hoje, providerRef ainda desconhecido) devolve 5xx sem
   * incrementar `attempts`, de proposito — para ele a pergunta e "ha quanto
   * tempo esta inaplicavel", nao "quantas vezes falhou".
   *
   * ACOPLAMENTO com paymentWindowMinutes, validado no boot: quem destrava essa
   * populacao e o job de reconciliacao do Bloco 6b, preenchendo o providerRef
   * da tentativa presa — e ele so age sobre tentativas mais velhas que a
   * janela. Um limite menor ou igual a janela quarentenaria eventos que o job
   * resolveria minutos depois.
   */
  webhookQuarantineMinutes: number;
  /**
   * Intervalo entre ciclos das varreduras de manutencao (reconciliacao e
   * inbox). Sai de `process.env` solto e entra aqui porque PARTICIPA de um
   * invariante entre campos — ver a validacao no `loadConfig`. Achado 4.2 da
   * 2a rodada de review do PR #58: sem ele, quarentena 2 min + poll 60 min era
   * configuracao valida e quarentenava antes de o job ter QUALQUER chance.
   */
  jobsPollIntervalMs: number;
  /** Quanto o shutdown espera o ciclo em voo antes de seguir. */
  jobsStopTimeoutMs: number;
  /**
   * Prazo de UMA varredura. Achado 4.3: sem prazo, uma varredura que nunca
   * resolve (nao rejeita) segura o `await` do ciclo, o proximo timer nunca e
   * agendado, e TODAS as varreduras param — inclusive as que estao saudaveis.
   */
  jobsVarreduraTimeoutMs: number;
  /**
   * URL do broker. `null` significa relay DESLIGADO — permitido apenas fora de
   * producao, para desenvolver sem RabbitMQ de pe.
   */
  rabbitmqUrl: string | null;
}

/**
 * Quantas varreduras o runtime roda por ciclo. Entra no invariante temporal
 * porque o proximo ciclo so e agendado DEPOIS de todas elas, e cada uma pode
 * consumir o prazo inteiro — achado 4.2 da 3a rodada de review do PR #58.
 *
 * O `server.ts` verifica que a lista real tem este tamanho: constante que
 * silenciosamente diverge do codigo e pior que constante nenhuma.
 */
export const VARREDURAS_SEMPRE_ATIVAS = 2;

/**
 * Quantas varreduras rodam por ciclo, dado o estado da flag de expiracao.
 *
 * Achado 4.1 da 2a rodada do PR #60: a constante era FIXA em 3, entao com a
 * expiracao DESLIGADA o boot exigia margem para uma varredura que nao roda —
 * e recusava configuracao que era valida antes do PR. Uma feature default-off
 * derrubando implantacao e pior que a feature.
 *
 * Derivar da flag tambem permitiu VOLTAR a igualdade estrita no guard do
 * server.ts, que a versao anterior tinha afrouxado para `>`.
 */
export function varredurasPorCiclo(expiracaoHabilitada: boolean): number {
  return VARREDURAS_SEMPRE_ATIVAS + (expiracaoHabilitada ? 1 : 0);
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

/**
 * Mesmo idioma de parseTimeout e parseMinutos, INCLUSIVE na tolerancia do
 * `Number()` a hexadecimal e exponencial. A divida registrada diz que os
 * parsers irmaos endurecem juntos ou nenhum: corrigir so um cria divergencia
 * silenciosa entre eles. Este e o terceiro da familia.
 */
function parseTentativas(raw: string | undefined, nome: string, padrao: number): number {
  if (raw === undefined || raw.trim() === '') return padrao;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ConfigError(`${nome} invalido: ${raw}. Use inteiro entre 1 e 100.`);
  }
  return n;
}

/**
 * Familia de parseMinutos, com teto MAIOR: 7 dias.
 *
 * O teto de 1440 da janela de pagamento existe porque ela prende estoque
 * reservado. A quarentena nao prende nada — ela so decide quando paramos de
 * tentar aplicar um evento, e dias sao horizonte legitimo. Com o mesmo teto nos
 * dois, uma janela de 1440 tornaria o boot IMPOSSIVEL: nao existiria valor de
 * quarentena maior que ela, e a validacao cruzada recusaria qualquer config.
 */
function parseMinutosLongos(raw: string | undefined, nome: string, padrao: number): number {
  if (raw === undefined || raw.trim() === '') return padrao;
  const minutos = Number(raw);
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > 10_080) {
    throw new ConfigError(`${nome} invalido: ${raw}. Use inteiro entre 1 e 10080.`);
  }
  return minutos;
}

function parseMs(
  raw: string | undefined,
  nome: string,
  padrao: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return padrao;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < min || ms > max) {
    throw new ConfigError(`${nome} invalido: ${raw}. Use inteiro entre ${min} e ${max}.`);
  }
  return ms;
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

/**
 * Espelha deliberadamente o tratamento de ORDER_SERVICE_URL: a credencial viaja
 * DENTRO da URL do broker, entao transporte em texto claro em producao expoe
 * usuario e senha a quem estiver na rede.
 *
 * Ausencia e FAIL-CLOSED em producao pelo mesmo motivo do PAYMENT_PROVIDER=fake:
 * sem broker, o pagamento e capturado e o pedido nunca fica sabendo —
 * inconsistencia silenciosa entre servicos. Em development/test a ausencia apenas
 * desliga o relay, com log explicito.
 */
function parseAmqpUrl(
  raw: string | undefined,
  nodeEnv: NodeEnv,
  permitirInseguro: boolean,
): string | null {
  const valor = (raw ?? '').trim();

  if (valor === '') {
    if (nodeEnv === 'production') {
      throw new ConfigError(
        'RABBITMQ_URL e obrigatoria em production: sem broker, a captura nunca chega ao order-service.',
      );
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(valor);
  } catch {
    // Nunca interpolamos a URL na mensagem: ela contem a senha.
    throw new ConfigError('RABBITMQ_URL nao e uma URL valida');
  }

  if (parsed.protocol !== 'amqp:' && parsed.protocol !== 'amqps:') {
    throw new ConfigError(`RABBITMQ_URL usa protocolo nao suportado: ${parsed.protocol}`);
  }
  // `new URL('amqp:broker')` NAO lanca: amqp nao e um esquema "special" na spec
  // WHATWG, entao sem `//` o resto vira path opaco e hostname fica vazio. URL
  // valida, endereco inexistente. Sem esta checagem o erro so apareceria no
  // connect, em runtime, em vez de no boot.
  if (parsed.hostname === '') {
    throw new ConfigError('RABBITMQ_URL sem host: nao ha endereco de broker para conectar');
  }

  if (nodeEnv === 'production' && parsed.protocol === 'amqp:' && !permitirInseguro) {
    throw new ConfigError(
      'RABBITMQ_URL em texto claro (amqp://) em production. A credencial viaja na URL. ' +
        'Use amqps:// ou declare RABBITMQ_ALLOW_INSECURE=true se o transporte ja for protegido.',
    );
  }

  return valor;
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

  const paymentWindowMinutes = parseMinutos(
    source.PAYMENT_WINDOW_MINUTES,
    'PAYMENT_WINDOW_MINUTES',
    15,
  );
  const webhookQuarantineMinutes = parseMinutosLongos(
    source.WEBHOOK_QUARANTINE_MINUTES,
    'WEBHOOK_QUARANTINE_MINUTES',
    60,
  );

  // Os NOMES continuam RECONCILIACAO_* de proposito: renomear quebraria .env em
  // uso para ganhar so estetica.
  const jobsPollIntervalMs = parseMs(
    source.RECONCILIACAO_POLL_INTERVAL_MS,
    'RECONCILIACAO_POLL_INTERVAL_MS',
    60_000,
    1_000,
    3_600_000,
  );
  const jobsStopTimeoutMs = parseMs(
    source.RECONCILIACAO_STOP_TIMEOUT_MS,
    'RECONCILIACAO_STOP_TIMEOUT_MS',
    5_000,
    1,
    60_000,
  );
  const jobsVarreduraTimeoutMs = parseMs(
    source.JOBS_VARREDURA_TIMEOUT_MS,
    'JOBS_VARREDURA_TIMEOUT_MS',
    120_000,
    1_000,
    600_000,
  );

  // Invariante ENTRE campos, por isso nao cabe em nenhum parser isolado.
  //
  // CORRIGIDO no achado 4.2 da 2a rodada de review do PR #58: a versao anterior
  // exigia apenas quarentena > janela, argumentando que o job de reconciliacao
  // destrava o evento. Mas o job so roda a cada ciclo, e o intervalo era lido
  // de process.env sem participar de validacao nenhuma — janela 1 min,
  // quarentena 2 min e poll 60 min passavam no boot e quarentenavam o evento
  // antes de o job ter QUALQUER chance de agir. A quarentena e terminal.
  // Somar SO o intervalo ainda era otimista (achado 4.2 da 3a rodada): o
  // proximo ciclo so e agendado depois que TODAS as varreduras terminam, e cada
  // uma pode consumir o prazo inteiro. Janela 1, poll 1, quarentena 3 e prazo
  // de 10 min passavam no boot — e a reentrega sincrona quarentenava o evento
  // muito antes da proxima reconciliacao.
  // A folga tem de refletir as varreduras EFETIVAMENTE habilitadas.
  const expiracaoHabilitada = source.PAYMENT_EXPIRATION_ENABLED === 'true';
  const porCiclo = varredurasPorCiclo(expiracaoHabilitada);
  const minutosDePoll = Math.ceil(jobsPollIntervalMs / 60_000);
  const minutosDeCiclo = Math.ceil((jobsVarreduraTimeoutMs * porCiclo) / 60_000);
  const folgaMinima = paymentWindowMinutes + minutosDePoll + minutosDeCiclo;

  if (webhookQuarantineMinutes <= folgaMinima) {
    throw new ConfigError(
      `WEBHOOK_QUARANTINE_MINUTES (${webhookQuarantineMinutes}) deve ser MAIOR que ` +
        `${folgaMinima}: PAYMENT_WINDOW_MINUTES (${paymentWindowMinutes}) mais o ` +
        `intervalo do job (${minutosDePoll} min) mais a duracao maxima de um ciclo ` +
        `(${minutosDeCiclo} min). Quem destrava um evento inaplicavel e a reconciliacao, ` +
        'e ela so age depois da janela E no ciclo seguinte, que so comeca quando todas ' +
        'as varreduras terminarem. Um limite menor quarentena eventos que seriam ' +
        'resolvidos, e a quarentena e terminal.',
    );
  }

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
    paymentWindowMinutes,
    webhookQuarantineMinutes,
    expiracaoHabilitada,
    varredurasPorCiclo: porCiclo,
    webhookMaxAttempts: parseTentativas(source.WEBHOOK_MAX_ATTEMPTS, 'WEBHOOK_MAX_ATTEMPTS', 5),
    jobsPollIntervalMs,
    jobsStopTimeoutMs,
    jobsVarreduraTimeoutMs,
    rabbitmqUrl: parseAmqpUrl(
      source.RABBITMQ_URL,
      nodeEnv,
      parseBooleano(source.RABBITMQ_ALLOW_INSECURE, 'RABBITMQ_ALLOW_INSECURE'),
    ),
  };
}
