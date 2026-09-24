import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  ProviderInvalidRequestError,
  WebhookSignatureError,
  type PaymentProvider,
} from '../providers/payment-provider.port';
import type { WebhookService } from '../services/webhook.service';

/**
 * Teto do corpo CRU. Maior que os 10kb do express.json global porque payload de
 * provedor carrega a cobranca inteira mais metadados; pequeno o bastante para
 * nao ser vetor de exaustao de memoria. O 413 gerado aqui e traduzido pelo
 * handler de erro do app, que ja converte status de cliente em 4xx.
 */
export const LIMITE_CORPO_WEBHOOK = '64kb';

export interface WebhookRouterDeps {
  provider: PaymentProvider;
  service: WebhookService;
  /** Injetavel para testar o teto de log sem esperar a janela real. */
  agora?: () => number;
}

/** Janela e teto do LOG de recusa (nao da rota: a recusa sempre acontece). */
export const JANELA_DE_LOG_MS = 60_000;
export const TETO_DE_LOG_POR_JANELA = 1;

/**
 * Bloco 9a-2: uma linha por recusa de 400/401. Antes, assinatura forjada e
 * segredo errado em producao eram recusados em SILENCIO.
 *
 * Campos FECHADOS — codigo e tamanho do corpo. Nada que venha de quem chama
 * entra como texto: nem o corpo, nem o cabecalho de assinatura, nem
 * req.params.provider (CR/LF forjaria linhas no log), nem a mensagem do erro
 * (ProviderInvalidRequestError pode citar o payload). O 404 fica de fora de
 * proposito: e o que qualquer scanner de URL gera, ruido sem sinal.
 */
type CodigoDeRecusa = 'CORPO_INVALIDO' | 'ASSINATURA_INVALIDA' | 'EVENTO_INVALIDO';

export function criarWebhookRouter(deps: WebhookRouterDeps): Router {
  const router = Router();
  const agora = deps.agora ?? ((): number => Date.now());

  // Estado POR ROUTER, nao de modulo: dois routers no mesmo processo (testes,
  // ou um segundo provedor) nao dividem contador, e nada precisa ser resetado
  // entre casos.
  const janelas = new Map<CodigoDeRecusa, { inicio: number; emitidas: number; suprimidas: number }>();

  /**
   * Rodada 3 do review do PR #71: o log era ilimitado, e `CORPO_INVALIDO` e
   * recusado ANTES da verificacao de assinatura — ou seja, sem custo de HMAC
   * para quem chama. Um laco de requisicoes invalidas viraria flood de log.
   *
   * Teto por CODIGO e por janela. As recusas suprimidas nao desaparecem: elas
   * saem como `suprimidas` na proxima linha emitida daquele codigo, entao o
   * volume real continua visivel sem uma linha por requisicao.
   */
  function registrarRecusa(code: CodigoDeRecusa, corpo: unknown): void {
    const t = agora();
    let janela = janelas.get(code);
    if (janela === undefined || t - janela.inicio >= JANELA_DE_LOG_MS) {
      janela = { inicio: t, emitidas: 0, suprimidas: janela?.suprimidas ?? 0 };
      janelas.set(code, janela);
    }
    if (janela.emitidas >= TETO_DE_LOG_POR_JANELA) {
      janela.suprimidas += 1;
      return;
    }
    janela.emitidas += 1;
    const suprimidas = janela.suprimidas;
    janela.suprimidas = 0;
    console.warn('[payment-service] webhook recusado', {
      code,
      bytes: Buffer.isBuffer(corpo) ? corpo.length : null,
      ...(suprimidas > 0 ? { suprimidas } : {}),
    });
  }

  router.post(
    '/:provider',
    // express.raw AQUI, e nao no app: assim o corpo cru nunca vaza para
    // nenhuma outra rota. O `type` restringe ao content-type do provedor.
    express.raw({ type: 'application/json', limit: LIMITE_CORPO_WEBHOOK }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // ARMADILHA: express.raw com type que NAO casa nao lanca — deixa
        // req.body como {}. Sem esta guarda, a verificacao rodaria sobre um
        // objeto vazio e o comportamento seria imprevisivel.
        if (!Buffer.isBuffer(req.body)) {
          registrarRecusa('CORPO_INVALIDO', req.body);
          res.status(400).json({
            code: 'CORPO_INVALIDO',
            error: 'Corpo do webhook deve ser enviado como application/json',
          });
          return;
        }

        if (req.params.provider !== deps.provider.name) {
          res.status(404).json({
            code: 'PROVEDOR_DESCONHECIDO',
            error: 'Provedor nao configurado',
          });
          return;
        }

        let evento;
        try {
          evento = deps.provider.verifyWebhook({ rawBody: req.body, headers: req.headers });
        } catch (erro) {
          // Assinatura invalida NAO grava no inbox: gravar antes de autenticar
          // transformaria a rota em escrita nao autenticada em banco.
          if (erro instanceof WebhookSignatureError) {
            registrarRecusa('ASSINATURA_INVALIDA', req.body);
            res.status(401).json({
              code: 'ASSINATURA_INVALIDA',
              error: 'Assinatura do webhook invalida',
            });
            return;
          }
          // Origem confiavel, conteudo invalido. Sem providerEventId valido nao
          // ha chave para gravar no inbox.
          if (erro instanceof ProviderInvalidRequestError) {
            registrarRecusa('EVENTO_INVALIDO', req.body);
            res.status(400).json({
              code: 'EVENTO_INVALIDO',
              error: 'Evento do webhook invalido',
            });
            return;
          }
          throw erro;
        }

        const resultado = await deps.service.processar(deps.provider.name, evento);

        // Condicao possivelmente transitoria: 5xx para o provedor RETENTAR.
        // Responder 200 aqui encerraria o evento para sempre.
        if (resultado.retentavel === true) {
          res.status(503).json({
            code: 'EVENTO_AINDA_NAO_APLICAVEL',
            error: 'Evento recebido, ainda nao aplicavel. Retente.',
          });
          return;
        }

        // 200 para desfecho DEFINITIVO — aplicado, ignorado ou duplicata.
        // O corpo nao revela o desfecho interno: o provedor so precisa saber
        // que nao deve retentar.
        res.status(200).json({ received: true });
      } catch (erro) {
        next(erro);
      }
    },
  );

  return router;
}
