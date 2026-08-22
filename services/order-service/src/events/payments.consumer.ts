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
  | { tipo: 'ja-pago' }
  | { tipo: 'compensacao-registrada' }
  | { tipo: 'pedido-inexistente' }
  | { tipo: 'valor-divergente'; esperadoCents: number; recebidoCents: number };

export interface ConsumerDeps {
  aplicar: (ev: CapturaEvent) => Promise<ResultadoAplicacao>;
}

// Conteudo vindo do broker entra em log. Caractere de controle em log permite
// forjar linha falsa (CR/LF) e sujar terminal; o cap evita despejar payload.
export function sanitizarParaLog(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? '?' : ch;
  }
  return out.length > 200 ? out.slice(0, 200) + '...' : out;
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
    // C6 — falha de infra. NUNCA DLQ: perder evento por indisponibilidade
    // momentanea e o pior desfecho possivel aqui.
    return {
      type: 'nack-requeue',
      reason: 'falha ao aplicar: ' + sanitizarParaLog(err instanceof Error ? err.message : String(err)),
    };
  }

  switch (resultado.tipo) {
    case 'aplicado':
      return { type: 'ack', reason: 'processado' };
    case 'duplicata':
      // C1 — o @unique do inbox abortou a transacao inteira: o efeito nao
      // repetiu porque ja tinha acontecido.
      return { type: 'ack', reason: 'duplicata' };
    case 'ja-pago':
      // C4 — inbox sem a linha (purga, por exemplo) mas o efeito ja existe.
      return { type: 'ack', reason: 'pedido ja pago' };
    case 'compensacao-registrada':
      // C5 — dinheiro capturado com pedido cancelado. O evento FOI processado;
      // o que ele produziu foi uma pendencia de estorno.
      return { type: 'ack', reason: 'compensacao registrada' };
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
  }
}
