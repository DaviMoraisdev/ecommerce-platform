import amqp from 'amqplib';
import { DeliveryAction, decidirEntrega, decidirPorTamanho, sanitizarParaLog } from './payments.consumer';
import { aplicarCaptura } from '../services/payment-capture.service';
import {
  EXCHANGE_PAGAMENTOS,
  EXCHANGE_PAGAMENTOS_TYPE,
  QUEUE_PAGAMENTOS,
  DLX_PAGAMENTOS,
  DLQ_PAGAMENTOS,
  BINDING_PAYMENT_CAPTURED,
} from './payments.topology';

// Interface minima do canal: o que este modulo realmente usa. Depender do tipo
// completo do amqplib obrigaria a montar um duble gigante nos testes.
export interface ChannelLike {
  assertExchange(nome: string, tipo: string, opts: object): Promise<unknown>;
  assertQueue(nome: string, opts: object): Promise<unknown>;
  bindQueue(fila: string, exchange: string, chave: string): Promise<unknown>;
  prefetch(n: number): Promise<unknown> | void;
  ack(msg: unknown): void;
  nack(msg: unknown, allUpTo: boolean, requeue: boolean): void;
}

function toIntInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const REQUEUE_DELAY_MS = toIntInRange(process.env.PAYMENTS_REQUEUE_DELAY_MS, 1000, 50, 60000);
const RECONNECT_DELAY_MS = toIntInRange(process.env.PAYMENTS_RECONNECT_DELAY_MS, 5000, 100, 300000);

/**
 * Declara a topologia na ORDEM que importa: dead-letter primeiro.
 *
 * Se a fila principal fosse declarada antes da DLX existir, o argumento
 * x-dead-letter-exchange apontaria para um exchange inexistente e mensagens
 * rejeitadas sumiriam em silencio. E argumentos de fila duravel sao IMUTAVEIS:
 * corrigir depois exige recriar a fila (o notification ja pagou esse preco —
 * ver TECH_DEBT).
 */
export async function montarTopologia(ch: ChannelLike): Promise<void> {
  // O exchange e do payment-service. Declarar aqui tambem e idempotente (mesmo
  // tipo e durabilidade) e permite o order subir primeiro, sem ordem de boot.
  await ch.assertExchange(EXCHANGE_PAGAMENTOS, EXCHANGE_PAGAMENTOS_TYPE, { durable: true });

  await ch.assertExchange(DLX_PAGAMENTOS, 'fanout', { durable: true });
  await ch.assertQueue(DLQ_PAGAMENTOS, { durable: true });
  await ch.bindQueue(DLQ_PAGAMENTOS, DLX_PAGAMENTOS, '');

  await ch.assertQueue(QUEUE_PAGAMENTOS, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DLX_PAGAMENTOS },
  });
  await ch.bindQueue(QUEUE_PAGAMENTOS, EXCHANGE_PAGAMENTOS, BINDING_PAYMENT_CAPTURED);

  // Limite de dano, nao otimizacao: sem prefetch o broker despeja a fila
  // inteira no processo e um crash devolve tudo de uma vez.
  await ch.prefetch(1);
}

export async function executarAcao(
  ch: ChannelLike,
  msg: unknown,
  acao: DeliveryAction,
  atrasoRequeue: () => Promise<void>,
): Promise<void> {
  if (acao.type === 'ack') {
    ch.ack(msg);
    return;
  }
  if (acao.type === 'nack-dlq') {
    // requeue=false: vai para a DLX. true aqui seria loop infinito.
    ch.nack(msg, false, false);
    return;
  }
  // Atraso antes de devolver: falha persistente sem espera vira hot loop.
  await atrasoRequeue();
  ch.nack(msg, false, true);
}

type Conexao = Awaited<ReturnType<typeof amqp.connect>>;
type Canal = Awaited<ReturnType<Conexao['createChannel']>>;

const CLOSE_TIMEOUT_MS = toIntInRange(process.env.PAYMENTS_CLOSE_TIMEOUT_MS, 3000, 50, 60000);
// Deadline sobre a abertura INTEIRA. Sem ele, um createChannel ou um consume
// pendurado deixa `iniciando` preenchido para sempre: o single-flight faz toda
// tentativa futura esperar por uma promise que nunca resolve, e o consumidor
// morre em silencio com o HTTP saudavel.
const OPEN_TIMEOUT_MS = toIntInRange(process.env.PAYMENTS_OPEN_TIMEOUT_MS, 10000, 100, 300000);

let conexao: Conexao | null = null;
let canal: Canal | null = null;
let encerrando = false;
let iniciando: Promise<void> | null = null;
let reconexao: NodeJS.Timeout | null = null;

/**
 * Contador de sessao. Toda abertura carrega a geracao em que comecou, e todo
 * listener so age se a geracao ainda for a dele.
 *
 * Sem isso, o listener de um canal antigo derrubaria a sessao nova, e uma
 * abertura que terminasse tarde publicaria estado por cima de outra. E a mesma
 * classe de corrida que o publisher do payment teve nas rodadas 2 e 3 do PR
 * anterior — aqui ela vem resolvida de origem.
 */
let geracao = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Fechamento nunca pendura o encerramento: broker travado responderia nunca.
function comDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + ms + 'ms')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function fecharSilencioso(r: { close(): Promise<unknown> } | null): Promise<void> {
  if (!r) return;
  try {
    await comDeadline(Promise.resolve(r.close()), CLOSE_TIMEOUT_MS);
  } catch {
    /* ja fechado, ou travado: segue */
  }
}

export function estaConsumindo(): boolean {
  return canal !== null;
}

function agendarReconexao(): void {
  if (encerrando || reconexao !== null) return;
  reconexao = setTimeout(() => {
    reconexao = null;
    void iniciarConsumidorPagamentos();
  }, RECONNECT_DELAY_MS);
  // unref: timer pendente nao pode segurar o processo vivo no encerramento.
  reconexao.unref();
}

/**
 * Ponto UNICO de perda de sessao. Canal fechado, conexao fechada e consumer
 * cancelado pelo broker convergem aqui — antes, so a conexao tinha tratamento,
 * e as outras duas deixavam o servico "ativo" sem ninguem consumindo, com o
 * HTTP saudavel. Parada silenciosa e o pior modo de falha deste servico.
 */
function invalidarSessao(motivo: string): void {
  const ch = canal;
  const conn = conexao;
  canal = null;
  conexao = null;
  geracao++; // qualquer abertura em voo desta geracao vira obsoleta
  if (encerrando) return;
  console.error('[payments] sessao perdida (' + motivo + '); HTTP segue no ar, reconectando em ' + RECONNECT_DELAY_MS + 'ms');
  void fecharSilencioso(ch);
  void fecharSilencioso(conn);
  agendarReconexao();
}

interface EmAbertura {
  conn: Conexao | null;
  ch: Canal | null;
  // comDeadline REJEITA a promise observada, mas nao cancela o trabalho: a
  // execucao antiga segue criando canal, topologia e ate um consume. Sem esta
  // marca, o resultado tardio viraria um consumidor orfao, sem referencia
  // global e com listeners na mesma geracao da sessao nova.
  abortado: boolean;
}

/**
 * Aquisicao em voo, VISIVEL de fora.
 *
 * Antes, `ref` era local a abrirSessao: se o connect resolvesse e o
 * createChannel pendurasse, o encerramento nao tinha como alcancar a conexao ja
 * aberta — ela ficava sem dono, e o abortarSePreciso seguinte nunca chegava a
 * rodar para fecha-la.
 */
let emAbertura: EmAbertura | null = null;

// Fecha o que ja foi adquirido e SO ENTAO lanca. Lancar antes de fechar deixa
// conexao viva, sem referencia e sem dono — cada ciclo de retry vazaria uma.
async function abortarSePreciso(ref: EmAbertura, minhaGeracao: number): Promise<void> {
  if (!ref.abortado && !encerrando && geracao === minhaGeracao) return;
  const motivo = ref.abortado
    ? 'aquisicao abandonada pelo deadline'
    : encerrando
      ? 'encerramento durante a abertura'
      : 'sessao obsoleta';
  await fecharSilencioso(ref.ch);
  await fecharSilencioso(ref.conn);
  ref.ch = null;
  ref.conn = null;
  throw new Error(motivo);
}

function observarConexao(conn: Conexao, minhaGeracao: number): void {
  conn.on('error', (err) => {
    console.error('[payments] conexao com erro: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)));
  });
  conn.on('close', () => {
    if (geracao !== minhaGeracao) return;
    invalidarSessao('conexao fechada');
  });
}

function observarCanal(ch: Canal, minhaGeracao: number): void {
  ch.on('error', (err) => {
    console.error('[payments] canal com erro: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)));
  });
  ch.on('close', () => {
    if (geracao !== minhaGeracao) return;
    invalidarSessao('canal fechado');
  });
}

// Single-flight: uma reconexao agendada coincidindo com um inicio manual abriria
// duas conexoes, e a referencia global ficaria com uma orfa.
export function iniciarConsumidorPagamentos(): Promise<void> {
  if (iniciando) return iniciando;
  iniciando = abrirSessao().finally(() => {
    iniciando = null;
  });
  return iniciando;
}

async function abrirSessao(): Promise<void> {
  if (encerrando || canal !== null) return;

  // FAIL-CLOSED por decisao explicita. Este consumidor altera estado FINANCEIRO
  // a partir de mensagem cuja origem o servico nao consegue autenticar (ver
  // TECH_DEBT: nenhum publicador de evento e autenticado, correcao de
  // infraestrutura na Fase 7). Enquanto ACL por servico ou assinatura do evento
  // nao existirem, ligar por padrao seria expor uma superficie financeira nova
  // a qualquer principal com permissao de publicacao no exchange.
  //
  // A pre-condicao ja estava escrita no TECH_DEBT, mas escrita nao impede nada:
  // a flag e o que a torna efetiva.
  if (process.env.PAYMENTS_CONSUMER_ENABLED !== 'true') {
    console.warn(
      '[payments] consumidor DESATIVADO (PAYMENTS_CONSUMER_ENABLED != true). ' +
        'Ative apenas com credencial por servico e ACL de publicacao no exchange payments.',
    );
    return;
  }

  const url = process.env.RABBITMQ_URL;
  if (!url) {
    console.warn('[payments] RABBITMQ_URL nao definida, consumidor desativado');
    return;
  }

  const minhaGeracao = geracao;
  const ref: EmAbertura = { conn: null, ch: null, abortado: false };
  emAbertura = ref;

  try {
    // Cada recurso e observado e conferido no instante em que existe, nao no
    // fim da abertura: entre createChannel e a topologia ja da tempo de o
    // broker emitir error, e sem listener isso vira excecao nao tratada.
    // Deadline sobre a abertura INTEIRA, nao por etapa. Qualquer passo que
    // pendure — connect, createChannel, topologia ou consume — encerra aqui em
    // vez de deixar `iniciando` preenchido para sempre.
    const ch = await comDeadline(adquirir(url, ref, minhaGeracao), OPEN_TIMEOUT_MS);

    if (ref.conn === null) throw new Error('conexao ausente apos a abertura');
    conexao = ref.conn;
    canal = ch;
    console.log('[payments] consumindo ' + QUEUE_PAGAMENTOS + ' (binding ' + BINDING_PAYMENT_CAPTURED + '); DLQ: ' + DLQ_PAGAMENTOS);
  } catch (err) {
    console.error('[payments] falha ao iniciar consumidor: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)));
    // ANTES de fechar: a abertura pode ainda estar rodando (deadline apenas
    // abandona a promise). A marca faz o proximo ponto de checagem dela fechar
    // o que adquirir depois daqui; a geracao invalida os listeners tardios.
    ref.abortado = true;
    geracao++;
    await fecharSilencioso(ref.ch);
    await fecharSilencioso(ref.conn);
    if (!encerrando) agendarReconexao();
  } finally {
    if (emAbertura === ref) emAbertura = null;
  }
}

async function adquirir(url: string, ref: EmAbertura, minhaGeracao: number): Promise<Canal> {
  const conn = await amqp.connect(url);
  ref.conn = conn;
  observarConexao(conn, minhaGeracao);
  await abortarSePreciso(ref, minhaGeracao);

  const ch = await conn.createChannel();
  ref.ch = ch;
  observarCanal(ch, minhaGeracao);
  await abortarSePreciso(ref, minhaGeracao);

  await montarTopologia(ch);
  await abortarSePreciso(ref, minhaGeracao);

  await ch.consume(QUEUE_PAGAMENTOS, (msg) => {
      if (!msg) {
        // Broker cancelou a assinatura: a sessao acabou, ainda que a conexao
        // continue de pe. Apenas retornar deixaria o consumidor "ativo" sem
        // ninguem consumindo.
        if (geracao === minhaGeracao) invalidarSessao('consumer cancelado pelo broker');
        return;
      }
      // .catch obrigatorio: uma rejeicao aqui nao tem observador e vira
      // unhandledRejection, que pode derrubar o processo HTTP inteiro —
      // exatamente o que o isolamento deste consumidor existe para evitar.
      void tratarMensagem(ch as Canal, msg).catch((err) => {
        console.error('[payments] falha nao tratada no handler: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)));
        // So logar deixaria a mensagem UNACKED. Com prefetch(1) isso bloqueia
        // todas as seguintes e o servico segue parecendo saudavel. Fechar o
        // canal devolve as nao confirmadas para a fila — nao ha como dispor da
        // mensagem por um canal que acabou de falhar.
        if (geracao === minhaGeracao) invalidarSessao('falha ao dispor da mensagem');
      });
    });
  await abortarSePreciso(ref, minhaGeracao);
  return ch;
}

// Exportada para teste: e o unico ponto onde uma rejeicao poderia escapar do
// callback do broker, entao ela precisa ser exercitavel diretamente.
export async function tratarMensagem(ch: Canal, msg: { content: Buffer; fields: { routingKey: string } }): Promise<void> {
  const routingKey = msg.fields.routingKey;

  // Tamanho ANTES da conversao: toString de um buffer gigante ja e o consumo
  // de memoria que se quer evitar.
  const porTamanho = decidirPorTamanho(msg.content.length);
  if (porTamanho !== null) {
    console.warn('[payments] ' + sanitizarParaLog(porTamanho.reason));
    // MESMA protecao do caminho normal: este ramo estava fora do try/catch, e
    // um nack falhando com o canal ja morto rejeitava sem observador.
    // NAO engole: quem chama invalida a sessao, porque uma mensagem sem
    // destino trava o slot do prefetch(1).
    await executarAcao(ch, msg, porTamanho, () => sleep(REQUEUE_DELAY_MS));
    return;
  }

  let acao: DeliveryAction;
  try {
    acao = await decidirEntrega(msg.content.toString(), routingKey, { aplicar: aplicarCaptura });
  } catch (err) {
    // decidirEntrega ja classifica falha de aplicacao; cair aqui e falha do
    // proprio decisor, e requeue continua sendo o conservador.
    acao = { type: 'nack-requeue', reason: sanitizarParaLog(err instanceof Error ? err.message : String(err)) };
  }

  if (acao.type !== 'ack') {
    // A reason carrega campos do payload (moeda, valores, mensagem de erro).
    // Sanitizar a linha INTEIRA no ponto de saida, nao so a routing key.
    console.warn('[payments] ' + acao.type + ' (' + sanitizarParaLog(routingKey) + '): ' + sanitizarParaLog(acao.reason));
  }

  // Sem try/catch: falha aqui significa mensagem sem destino, e quem chama
  // precisa saber para invalidar a sessao.
  await executarAcao(ch, msg, acao, () => sleep(REQUEUE_DELAY_MS));
}

export async function pararConsumidorPagamentos(): Promise<void> {
  encerrando = true;
  if (reconexao !== null) {
    clearTimeout(reconexao);
    reconexao = null;
  }
  // NAO espera a abertura em voo: ela confere `encerrando` apos cada await e
  // fecha sozinha o que adquiriu. Esperar aqui penduraria o shutdown num
  // amqp.connect que pode nunca responder.
  const ch = canal;
  const conn = conexao;
  canal = null;
  conexao = null;
  geracao++;

  // Fecha tambem o que uma abertura em voo ja adquiriu. Ela pode estar parada
  // num await que nunca resolve — nesse caso ela sozinha nunca fecharia nada.
  const provisorio = emAbertura;
  emAbertura = null;

  await fecharSilencioso(ch);
  await fecharSilencioso(conn);
  if (provisorio) {
    await fecharSilencioso(provisorio.ch);
    await fecharSilencioso(provisorio.conn);
    provisorio.ch = null;
    provisorio.conn = null;
  }
}
