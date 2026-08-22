import amqp from 'amqplib';
import { DeliveryAction, decidirEntrega, sanitizarParaLog } from './payments.consumer';
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

let conexao: Conexao | null = null;
let canal: Canal | null = null;
let encerrando = false;
let reconexao: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function agendarReconexao(): void {
  if (encerrando || reconexao !== null) return;
  reconexao = setTimeout(() => {
    reconexao = null;
    void iniciarConsumidorPagamentos();
  }, RECONNECT_DELAY_MS);
  // unref: um timer pendente nao pode segurar o processo vivo no encerramento.
  reconexao.unref();
}

/**
 * Sobe o consumidor. NAO derruba o processo em falha, e essa e a divergencia
 * deliberada em relacao ao notification-service.
 *
 * La, `connection.on('close') -> process.exit(1)` esta certo: e um worker puro,
 * reiniciar E a recuperacao. O order serve a API de pedidos. Matar o HTTP
 * porque o broker caiu troca degradacao parcial (eventos atrasam) por
 * indisponibilidade total (ninguem cria pedido).
 */
export async function iniciarConsumidorPagamentos(): Promise<void> {
  if (encerrando || canal !== null) return;

  const url = process.env.RABBITMQ_URL;
  if (!url) {
    console.warn('[payments] RABBITMQ_URL nao definida, consumidor desativado');
    return;
  }

  try {
    const conn = await amqp.connect(url);
    const ch = await conn.createChannel();
    await montarTopologia(ch);

    // Listeners antes de consumir: sem listener de error num EventEmitter, o
    // evento vira excecao nao tratada e mata o processo — justamente o que
    // este desenho quer evitar.
    conn.on('error', (err) => {
      console.error('[payments] conexao com erro: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)));
    });
    conn.on('close', () => {
      if (conexao !== conn) return;
      conexao = null;
      canal = null;
      if (encerrando) return;
      console.error('[payments] conexao fechada; HTTP segue no ar, reconectando em ' + RECONNECT_DELAY_MS + 'ms');
      agendarReconexao();
    });
    ch.on('error', (err) => {
      console.error('[payments] canal com erro: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)));
    });

    await ch.consume(QUEUE_PAGAMENTOS, (msg) => {
      if (!msg) return; // consumo cancelado pelo broker
      void (async () => {
        const routingKey = msg.fields.routingKey;
        let acao: DeliveryAction;
        try {
          acao = await decidirEntrega(msg.content.toString(), routingKey, { aplicar: aplicarCaptura });
        } catch (err) {
          // decidirEntrega ja converte falha de aplicacao em requeue; cair aqui
          // e falha do proprio decisor, e requeue continua sendo o conservador.
          acao = { type: 'nack-requeue', reason: sanitizarParaLog(err instanceof Error ? err.message : String(err)) };
        }
        if (acao.type !== 'ack') {
          console.warn('[payments] ' + acao.type + ' (' + sanitizarParaLog(routingKey) + '): ' + acao.reason);
        }
        try {
          await executarAcao(ch, msg, acao, () => sleep(REQUEUE_DELAY_MS));
        } catch (err) {
          // Canal ja morto: a mensagem volta para a fila sozinha, sem ack.
          console.error('[payments] falha ao aplicar acao no canal: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)));
        }
      })();
    });

    conexao = conn;
    canal = ch;
    console.log('[payments] consumindo ' + QUEUE_PAGAMENTOS + ' (binding ' + BINDING_PAYMENT_CAPTURED + '); DLQ: ' + DLQ_PAGAMENTOS);
  } catch (err) {
    console.error('[payments] falha ao iniciar consumidor: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)));
    conexao = null;
    canal = null;
    agendarReconexao();
  }
}

export async function pararConsumidorPagamentos(): Promise<void> {
  encerrando = true;
  if (reconexao !== null) {
    clearTimeout(reconexao);
    reconexao = null;
  }
  const ch = canal;
  const conn = conexao;
  canal = null;
  conexao = null;
  try {
    if (ch) await ch.close();
  } catch {
    /* canal ja fechado */
  }
  try {
    if (conn) await conn.close();
  } catch {
    /* conexao ja fechada */
  }
}
