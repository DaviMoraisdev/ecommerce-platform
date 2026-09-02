import type {
  ChargeResult,
  ChargeSnapshot,
} from '../providers/payment-provider.port';

/**
 * EXPIRACAO DA JANELA (Bloco 6e).
 *
 * Populacao COMPLEMENTAR a da reconciliacao (6b): la, `providerRef` NULO
 * significa 'chamamos o provedor e nao sabemos o que aconteceu'. Aqui,
 * `providerRef` PRESENTE significa "a cobranca existe e o provedor nunca
 * concluiu". A primeira se resolve PERGUNTANDO; esta, COMANDANDO o
 * cancelamento.
 *
 * A decisao pura e a varredura entram no incremento 2.
 */

/** Uma tentativa cuja cobranca existe e passou da janela. */
export interface TentativaExpirando {
  id: string;
  paymentId: string;
  attemptCount: number;
  /**
   * Nao-nulo por construcao do WHERE. Tipo proprio em vez de campo opcional em
   * `TentativaPresa`: opcional obrigaria checagem de null em runtime para algo
   * que a consulta ja garante, e checagem redundante ensina a proxima pessoa
   * que o campo pode faltar.
   */
  providerRef: string;
  /** Compoe o cursor da paginacao junto com o `id`. */
  createdAt: Date;
}

/**
 * O que fazer com uma tentativa expirando, dado o estado em que a cobranca
 * FICOU depois do comando de cancelamento.
 *
 * Nao existe variante `aguardar`, ao contrario da reconciliacao: la o job so
 * PERGUNTA, e esperar e resposta legitima. Aqui ja COMANDAMOS o cancelamento —
 * se mesmo assim a cobranca segue em processamento, isso e anomalia e vai para
 * triagem, nunca para uma nova rodada de espera silenciosa.
 */
export type AcaoDeExpiracao =
  /** Cancelamento confirmado no provedor: o pagamento vira EXPIRED. */
  | { tipo: 'expirar' }
  /** O provedor tem desfecho: aplica pelo MESMO caminho do fluxo normal. */
  | { tipo: 'aplicar'; resultado: ChargeResult }
  /** Estado que o job nao sabe aplicar com seguranca. Nao toca, e sinaliza. */
  | { tipo: 'triagem'; motivo: string };

/**
 * Funcao PURA: sem banco, sem provedor, sem relogio.
 *
 * O snapshot chega por DOIS caminhos que convergem: o retorno normal do
 * cancelCharge, ou — quando ele recusa com ChargeNotCancelableError — a leitura
 * subsequente do getCharge. Fazer os dois desaguarem no mesmo tipo e o que
 * permite UM ponto de decisao, em vez de regra de negocio espalhada por um
 * `catch`.
 *
 * A traducao de SUCCEEDED e DECLINED repete a de `decidirReconciliacao` de
 * proposito. Extrair criaria um modulo compartilhado para poucas linhas cuja
 * divergencia o COMPILADOR ja pega (os campos vem de ChargeResult), e acoplaria
 * duas decisoes que o projeto separou deliberadamente. A unica regra de
 * julgamento e a do `declineCode`, e ela esta explicada nos dois lugares.
 */
export function decidirExpiracao(snapshot: ChargeSnapshot): AcaoDeExpiracao {
  switch (snapshot.state) {
    case 'CANCELED':
      // Unico caminho que produz EXPIRED. O comando pegou: a cobranca esta
      // morta no provedor e o dinheiro reservado foi liberado.
      return { tipo: 'expirar' };

    case 'SUCCEEDED':
      // O provedor capturou ANTES do nosso comando. Marcar EXPIRED aqui
      // registraria como expirado um pagamento que cobrou o cliente — o pior
      // desfecho possivel deste job. Aplica a captura pelo caminho normal.
      return {
        tipo: 'aplicar',
        resultado: {
          providerRef: snapshot.providerRef,
          state: 'SUCCEEDED',
          capturedAmountCents: snapshot.capturedAmountCents,
        },
      };

    case 'DECLINED':
      // Mesma regra do CASO R6: declineCode e opcional no snapshot e
      // OBRIGATORIO no ChargeResult. Preencher com fachada gravaria mentira na
      // resposta congelada, devolvida ao cliente em todo replay.
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
      // Comandamos o cancelamento e a cobranca continua andando. Ou o provedor
      // ignorou, ou o estado mudou entre o comando e a leitura. Nao inventar
      // desfecho: preso e visivel e melhor que resolvido no escuro.
      return {
        tipo: 'triagem',
        motivo: 'cobranca segue em processamento apos comando de cancelamento',
      };
  }
}
