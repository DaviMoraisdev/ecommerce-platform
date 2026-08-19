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
}

export function criarWebhookRouter(deps: WebhookRouterDeps): Router {
  const router = Router();

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
            res.status(401).json({
              code: 'ASSINATURA_INVALIDA',
              error: 'Assinatura do webhook invalida',
            });
            return;
          }
          // Origem confiavel, conteudo invalido. Sem providerEventId valido nao
          // ha chave para gravar no inbox.
          if (erro instanceof ProviderInvalidRequestError) {
            res.status(400).json({
              code: 'EVENTO_INVALIDO',
              error: 'Evento do webhook invalido',
            });
            return;
          }
          throw erro;
        }

        await deps.service.processar(deps.provider.name, evento);

        // 200 para tudo que foi REGISTRADO — aplicado, ignorado ou duplicata.
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
