export interface InboxDeps {
  quarentenarOrfaos: (limite: Date, lote: number) => Promise<number>;
  /** Ver AppConfig.webhookQuarantineMinutes. */
  idadeMinutos: number;
  agora?: () => Date;
  lote?: number;
}

export interface ResumoDoInbox {
  quarentenadas: number;
}

/**
 * Um ciclo da varredura do inbox.
 *
 * SEM cursor e SEM teto de lotes, ao contrario da reconciliacao do 6b — e a
 * diferenca e estrutural, nao descuido: la os itens nao-acionaveis PERMANECIAM
 * candidatos, entao um lote deles congelava a fila. Aqui a linha tratada SAI do
 * conjunto (vira QUARANTINED), entao um lote limitado por ciclo progride por
 * construcao.
 */
export async function tickInbox(deps: InboxDeps): Promise<ResumoDoInbox> {
  const agora = deps.agora ? deps.agora() : new Date();
  const lote =
    deps.lote !== undefined && Number.isInteger(deps.lote) && deps.lote >= 1 && deps.lote <= 500
      ? deps.lote
      : 100;

  const limite = new Date(agora.getTime() - deps.idadeMinutos * 60_000);
  const quarentenadas = await deps.quarentenarOrfaos(limite, lote);

  if (quarentenadas > 0) {
    console.warn(
      '[payment-service] inbox: ' +
        String(quarentenadas) +
        ' evento(s) sem conclusao foram para quarentena e aguardam triagem',
    );
  }

  return { quarentenadas };
}
