import type { ChargeResult, ChargeSnapshot } from '../providers/payment-provider.port';

/**
 * O que fazer com uma tentativa presa, dado o que o PROVEDOR diz.
 *
 * Uniao discriminada: cada variante carrega so o que a sua aplicacao precisa,
 * e combinacao impossivel nao compila.
 */
export type AcaoDeReconciliacao =
  /** O provedor nunca recebeu. Nada de dinheiro se moveu; libera para nova tentativa. */
  | { tipo: 'liberar' }
  /** Ha desfecho: aplica pelo MESMO caminho do fluxo normal. */
  | { tipo: 'aplicar'; resultado: ChargeResult }
  /** O provedor ainda nao decidiu. O webhook resolve; nao tocar em nada. */
  | { tipo: 'aguardar' }
  /** Estado que o job nao sabe aplicar com seguranca. Nao toca, e sinaliza. */
  | { tipo: 'triagem'; motivo: string };

/**
 * Traduz o que o provedor diz AGORA no que o fluxo normal sabe aplicar.
 *
 * Funcao PURA: sem banco, sem provedor, sem relogio. E o que torna os casos
 * R1-R6 testaveis sem infraestrutura nenhuma.
 *
 * A assimetria que organiza tudo: aplicar desfecho errado mexe em dinheiro e e
 * irreversivel do ponto de vista do cliente; NAO aplicar deixa a tentativa
 * presa, o que ja e o estado atual e continua visivel. Na duvida, nao aplica.
 */
export function decidirReconciliacao(snapshot: ChargeSnapshot | null): AcaoDeReconciliacao {
  // Ausencia e a unica evidencia que autoriza refazer a tentativa: a chamada
  // nunca chegou, entao attemptCount + 1 (e chave de provedor nova) nao pode
  // duplicar cobranca.
  if (snapshot === null) return { tipo: 'liberar' };

  switch (snapshot.state) {
    case 'SUCCEEDED':
      return {
        tipo: 'aplicar',
        resultado: {
          providerRef: snapshot.providerRef,
          state: 'SUCCEEDED',
          capturedAmountCents: snapshot.capturedAmountCents,
        },
      };

    case 'DECLINED':
      // declineCode e OPCIONAL no snapshot e OBRIGATORIO no ChargeResult.
      // Preencher com um valor de fachada gravaria uma mentira na resposta
      // congelada, devolvida ao cliente em todo replay, para sempre — e
      // parecendo um codigo do provedor. Preso e visivel e melhor que liberado
      // com dado inventado.
      if (snapshot.declineCode === undefined) {
        return { tipo: 'triagem', motivo: 'recusa sem declineCode' };
      }
      return {
        tipo: 'aplicar',
        resultado: {
          providerRef: snapshot.providerRef,
          state: 'DECLINED',
          capturedAmountCents: 0,
          declineCode: snapshot.declineCode,
        },
      };

    case 'PROCESSING':
      // O provedor ainda nao decidiu. Aplicar aqui seria inventar desfecho.
      return { tipo: 'aguardar' };

    case 'CANCELED':
      // ChargeSnapshot admite CANCELED; ChargeResult nao — e o compilador
      // impede a traducao. Aplicar cancelamento e o outro item do Bloco 6
      // (expiracao da janela, com cancelCharge), e misturar os dois repetiria
      // o problema de escopo que alongou o 5b.
      return { tipo: 'triagem', motivo: 'cobranca cancelada no provedor' };
  }
}
