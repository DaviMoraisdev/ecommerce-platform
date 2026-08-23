import { Prisma } from '@prisma/client';
import { CapturaEvent, parseCaptura } from './payment-events';
import { BINDING_PAYMENT_CAPTURED } from './payments.topology';

export type DeliveryAction =
  | { type: 'ack'; reason: string }
  | { type: 'nack-dlq'; reason: string }
  | { type: 'nack-requeue'; reason: string };

// O que a camada de banco reporta. Cada variante vira uma acao diferente no
// broker, e essa traducao e o que os casos C1-C9 fixam.
export type ResultadoAplicacao =
  | { tipo: 'aplicado' }
  | { tipo: 'duplicata' }
  // Nao existe mais 'ja-pago': com eventId derivado do paymentId, a redentrega
  // do MESMO pagamento colide no @unique antes de chegar ao estado do pedido.
  // Logo, tudo que alcanca a checagem de status e OUTRO pagamento — segunda
  // cobranca, nunca "o efeito ja existe".
  | { tipo: 'compensacao-registrada'; motivo: string }
  | { tipo: 'pedido-inexistente' }
  | { tipo: 'valor-divergente'; esperadoCents: number; recebidoCents: number }
  | { tipo: 'captura-parcial'; autorizadoCents: number; capturadoCents: number }
  | { tipo: 'moeda-divergente'; esperada: string; recebida: string };

// Codigos do Prisma que NAO melhoram com o tempo: chave estrangeira violada,
// registro ausente, valor fora do tipo. Tentar de novo repete o mesmo erro.
//
// P2002 NAO entra. Violacao de unique nao e categoria de erro, e sinal de
// CONCORRENCIA: alguem chegou primeiro. No fluxo da compensacao, a transacao
// que perde a corrida aborta junto com o insert do inbox e PRECISA reprocessar
// para encontrar a pendencia ja criada. Classifica-lo como deterministico
// mandava essa corrida para a DLQ — o oposto do que o servico documenta.
const CODIGOS_DETERMINISTICOS = new Set(['P2000', 'P2003', 'P2011', 'P2012', 'P2025']);

/**
 * Classifica a falha. So volta true quando da para AFIRMAR que o erro e
 * deterministico — o desconhecido cai como transitorio e vira requeue.
 *
 * A assimetria e proposital: classificar transitorio como deterministico
 * DESCARTA um pagamento; o contrario apenas repete tentativa. Entre perder
 * dinheiro e gastar ciclo, gasta-se ciclo.
 *
 * O que isto resolve (achado 4.4): sem classificacao, um bug de programacao ou
 * uma constraint violada voltava para a fila indefinidamente e monopolizava o
 * unico slot do prefetch(1), travando mensagens validas atras dele.
 */
export function ehDeterministico(err: unknown): boolean {
  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) {
    return true;
  }
  if (err instanceof Prisma.PrismaClientValidationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return CODIGOS_DETERMINISTICOS.has(err.code);
  }
  return false;
}

const MAX_TENTATIVAS = (() => {
  const n = Number(process.env.PAYMENTS_MAX_TENTATIVAS);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 5;
})();

/**
 * Tentativas por eventId, em memoria.
 *
 * Isto torna decidirEntrega IMPURA de proposito: contar tentativas exige
 * memoria ENTRE entregas, e nao existe onde guardar isso sem estado. A
 * alternativa seria uma retry queue com TTL e x-death, que e comportamento do
 * BROKER — nao daria para provar com dublê, e entregar maquina nao testavel
 * chamando de correcao e pior que a impureza.
 *
 * O que isto resolve: sem teto, um erro permanente que a classificacao nao
 * reconhece volta para a fila indefinidamente e monopoliza o unico slot do
 * prefetch(1), travando todas as mensagens validas atras dele. Com teto, a
 * mensagem vai para a DLQ — PRESERVADA, nao descartada.
 *
 * Limitacao registrada no TECH_DEBT: o contador morre com o processo, entao um
 * reinicio zera a contagem.
 */
const tentativas = new Map<string, number>();

export function resetarTentativas(): void {
  tentativas.clear();
}

function contarRequeue(chave: string): number {
  const n = (tentativas.get(chave) ?? 0) + 1;
  tentativas.set(chave, n);
  return n;
}

export interface ConsumerDeps {
  aplicar: (ev: CapturaEvent) => Promise<ResultadoAplicacao>;
}

// Teto de bytes da mensagem. prefetch(1) limita QUANTAS mensagens chegam por
// vez, nao o TAMANHO de uma. Sem isto, uma mensagem gigante e convertida em
// string e parseada antes de qualquer defesa.
export const MAX_PAYLOAD_BYTES = 64 * 1024;

// Decide pelo TAMANHO, antes de converter para string. Retorna null quando o
// tamanho e aceitavel e o fluxo normal deve seguir.
export function decidirPorTamanho(bytes: number): DeliveryAction | null {
  if (bytes <= MAX_PAYLOAD_BYTES) return null;
  // DLQ, nao requeue: a mesma mensagem grande voltaria para sempre.
  return {
    type: 'nack-dlq',
    reason: 'payload acima do limite: ' + bytes + ' bytes (max ' + MAX_PAYLOAD_BYTES + ')',
  };
}

// Conteudo vindo do broker entra em log. Duas defesas distintas:
//  - caractere de controle: CR/LF permite forjar linha de log falsa;
//  - credencial: err.message de biblioteca costuma trazer a URL do broker
//    inteira, com a senha dentro do userinfo.
// A redacao e por token, sem regex: regex sobre entrada nao controlada e
// superficie de ReDoS e sempre deixa um caso escapar. Mesma abordagem do
// motivoSeguro do payment-service.
export function sanitizarParaLog(s: string): string {
  let semControle = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    semControle += code < 32 || code === 127 ? '?' : ch;
  }
  const redigido = semControle
    .split(' ')
    .map((parte) => (parte.includes('://') ? '[uri redigida]' : parte))
    .join(' ');
  return redigido.length > 200 ? redigido.slice(0, 200) + '...' : redigido;
}

/**
 * Traduz o resultado do efeito em acao no broker. Funcao PURA: nao toca banco
 * nem canal — o efeito entra por deps.aplicar. E isso que torna C1-C9
 * testaveis sem RabbitMQ e sem Postgres.
 *
 * A regra que organiza a tabela toda: ack quando o efeito desejado ja existe
 * (ainda que produzido por outra entrega), requeue quando a proxima tentativa
 * tem chance real de funcionar, DLQ quando nenhuma tentativa futura funciona.
 */
export async function decidirEntrega(
  raw: string,
  routingKey: string,
  deps: ConsumerDeps,
): Promise<DeliveryAction> {
  // C8 — antes de tudo: o binding e estrito, entao outra key aqui significa
  // topologia adulterada. Nao chega a tocar no banco.
  if (routingKey !== BINDING_PAYMENT_CAPTURED) {
    return {
      type: 'nack-dlq',
      reason: 'routing key fora do binding: ' + sanitizarParaLog(routingKey),
    };
  }

  // C2 — payload quebrado nao melhora com o tempo.
  const evento = parseCaptura(raw);
  if (evento === null) {
    return { type: 'nack-dlq', reason: 'payload invalido ou incompleto' };
  }

  let resultado: ResultadoAplicacao;
  try {
    resultado = await deps.aplicar(evento);
  } catch (err) {
    const motivo = sanitizarParaLog(err instanceof Error ? err.message : String(err));
    if (ehDeterministico(err)) {
      // Erro que nao muda com o tempo. Requeue aqui seria loop eterno ocupando
      // o unico slot do prefetch(1) e travando mensagens validas atras.
      tentativas.delete(evento.eventId);
      return { type: 'nack-dlq', reason: 'falha deterministica ao aplicar: ' + motivo };
    }
    // C6 — falha de infra. Requeue, porque perder evento por indisponibilidade
    // momentanea e o pior desfecho possivel aqui...
    const n = contarRequeue(evento.eventId);
    if (n > MAX_TENTATIVAS) {
      // ...mas nao para sempre: um erro permanente que a classificacao nao
      // reconhece travaria a fila inteira. DLQ preserva a mensagem.
      tentativas.delete(evento.eventId);
      return {
        type: 'nack-dlq',
        reason: 'excedeu ' + MAX_TENTATIVAS + ' tentativas transitorias: ' + motivo,
      };
    }
    return {
      type: 'nack-requeue',
      reason: 'falha transitoria (' + n + '/' + MAX_TENTATIVAS + '): ' + motivo,
    };
  }
  // Desfecho terminal: a contagem desta chave deixa de interessar.
  tentativas.delete(evento.eventId);

  switch (resultado.tipo) {
    case 'aplicado':
      return { type: 'ack', reason: 'processado' };
    case 'duplicata':
      // C1 — o @unique do inbox abortou a transacao inteira: o efeito nao
      // repetiu porque ja tinha acontecido.
      return { type: 'ack', reason: 'duplicata' };
    case 'compensacao-registrada':
      // C5 — o evento FOI processado; o que ele produziu foi uma pendencia de
      // estorno em vez de uma transicao.
      return { type: 'ack', reason: 'compensacao registrada: ' + resultado.motivo };
    case 'pedido-inexistente':
      // C3 — o payment so emite captura para pedido que consultou antes.
      return { type: 'nack-dlq', reason: 'pedido inexistente' };
    case 'valor-divergente':
      // C9 — violacao de contrato entre servicos. Retry repetiria a divergencia.
      return {
        type: 'nack-dlq',
        reason:
          'valor divergente: pedido ' + resultado.esperadoCents +
          ' centavos, evento ' + resultado.recebidoCents,
      };
    case 'captura-parcial':
      // Captura parcial NAO e suportada: o pedido nao tem como representar
      // pagamento incompleto. Aceitar levaria a PAGO com dinheiro faltando.
      return {
        type: 'nack-dlq',
        reason:
          'captura parcial nao suportada: autorizado ' + resultado.autorizadoCents +
          ', capturado ' + resultado.capturadoCents,
      };
    case 'moeda-divergente':
      return {
        type: 'nack-dlq',
        reason: 'moeda divergente: esperada ' + resultado.esperada + ', recebida ' + resultado.recebida,
      };
  }
}
