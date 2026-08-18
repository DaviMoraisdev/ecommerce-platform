import { PaymentStatus } from '@prisma/client';

import type { ChargeState } from '../providers/payment-provider.port';

/**
 * Maquina de estados do PAGAMENTO.
 *
 * NAO e a mesma do provedor. O `FakeProvider` tem uma tabela `TRANSICOES` para o
 * `ChargeState` dele, com quatro estados, que descreve a cobranca LA. Esta
 * descreve o pagamento AQUI, com sete — e inclui EXPIRED, que so existe do nosso
 * lado. O mapeamento entre as duas esta em `mapearEstadoDoProvedor`.
 *
 * O tipo vem do @prisma/client de proposito: o enum e gerado a partir do schema,
 * entao importa-lo impede divergencia entre dominio e banco. Uma uniao escrita a
 * mao pareceria mais limpa e drift silenciosamente.
 */

export class TransicaoDeStatusInvalidaError extends Error {
  constructor(de: PaymentStatus, para: PaymentStatus) {
    super(`transicao de pagamento invalida: ${de} -> ${para}`);
    this.name = 'TransicaoDeStatusInvalidaError';
  }
}

/**
 * Transicoes validas.
 *
 * Duas notas sobre estados que parecem esquecidos e nao estao:
 *
 * AUTHORIZED nao e alcancado hoje. A decisao 10 da fase e CAPTURA AUTOMATICA: o
 * provedor autoriza e captura numa operacao, entao nunca reporta um estado
 * intermediario so de autorizacao. O estado existe no enum e tem transicoes
 * declaradas para quando captura em duas fases entrar — o que pertence ao fluxo
 * de expedicao, fora desta fase.
 *
 * EXPIRED nao tem produtor ainda. Quem o produz e o job de expiracao da janela
 * de retentativa, no Bloco 6. As transicoes ja estao declaradas porque esta
 * tabela e o CONTRATO que aquele bloco vai consumir: deixa-la incompleta faria o
 * Bloco 6 precisar alterar o dominio.
 */
const TRANSICOES: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  // Criado, provedor ainda nao respondeu.
  [PaymentStatus.PENDING]: new Set([
    PaymentStatus.PROCESSING, // aceito, confirmacao vira por webhook
    PaymentStatus.CAPTURED, // captura automatica bem-sucedida na propria chamada
    PaymentStatus.FAILED, // recusado
    PaymentStatus.CANCELED,
    PaymentStatus.EXPIRED,
  ]),

  // Aguardando confirmacao do provedor.
  [PaymentStatus.PROCESSING]: new Set([
    PaymentStatus.CAPTURED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELED,
    PaymentStatus.EXPIRED,
  ]),

  // Fundos bloqueados, dinheiro nao movido. Sem produtor sob captura automatica.
  [PaymentStatus.AUTHORIZED]: new Set([
    PaymentStatus.CAPTURED,
    PaymentStatus.CANCELED,
    PaymentStatus.EXPIRED,
  ]),

  // Dinheiro movido. TERMINAL: reembolso NAO muda o status, e aritmetica sobre
  // refundedAmountCents (decisao 9 da fase).
  [PaymentStatus.CAPTURED]: new Set<PaymentStatus>([]),

  // Tentativa recusada, mas a JANELA DE RETENTATIVA continua aberta (decisao 5):
  // o cliente pode tentar outro cartao, e isso e uma nova tentativa do MESMO
  // pagamento. Por isso FAILED nao e terminal.
  [PaymentStatus.FAILED]: new Set([
    PaymentStatus.PROCESSING, // nova tentativa aceita, aguardando webhook
    PaymentStatus.CAPTURED, // nova tentativa capturada na propria chamada
    PaymentStatus.CANCELED,
    PaymentStatus.EXPIRED, // janela esgotou
  ]),

  // Janela esgotou sem captura. TERMINAL.
  [PaymentStatus.EXPIRED]: new Set<PaymentStatus>([]),

  // Cancelado deliberadamente. TERMINAL.
  [PaymentStatus.CANCELED]: new Set<PaymentStatus>([]),
};

const TERMINAIS: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.CAPTURED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELED,
]);

export function estaTerminal(status: PaymentStatus): boolean {
  return TERMINAIS.has(status);
}

/** Repetir o mesmo estado e permitido: replay de evento nao e transicao. */
export function podeTransicionar(de: PaymentStatus, para: PaymentStatus): boolean {
  if (de === para) return true;
  return TRANSICOES[de].has(para);
}

export function assertTransicao(de: PaymentStatus, para: PaymentStatus): void {
  if (!podeTransicionar(de, para)) {
    throw new TransicaoDeStatusInvalidaError(de, para);
  }
}

/**
 * Traduz o estado do provedor para o nosso.
 *
 * Switch exaustivo sobre ChargeState: acrescentar um estado na porta sem tratar
 * aqui vira erro de compilacao, nao `undefined` em runtime.
 *
 * Note que nenhum ChargeState mapeia para AUTHORIZED ou EXPIRED — o primeiro
 * porque a captura e automatica, o segundo porque expiracao e decisao NOSSA,
 * tomada pelo job do Bloco 6, e nao algo que o provedor reporte.
 */
export function mapearEstadoDoProvedor(state: ChargeState): PaymentStatus {
  switch (state) {
    case 'PROCESSING':
      return PaymentStatus.PROCESSING;
    case 'SUCCEEDED':
      return PaymentStatus.CAPTURED;
    case 'DECLINED':
      return PaymentStatus.FAILED;
    case 'CANCELED':
      return PaymentStatus.CANCELED;
  }
}
