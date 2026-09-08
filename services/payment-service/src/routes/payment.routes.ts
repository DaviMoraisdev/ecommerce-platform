import { Router, type RequestHandler } from 'express';

import type { PaymentController } from '../controllers/payment.controller';

export interface PaymentRouterDeps {
  authMiddleware: RequestHandler;
  controller: PaymentController;
  /** Injetado como o authMiddleware, pelo mesmo motivo: testavel com duble. */
  exigirAdmin: RequestHandler;
  /** Desligada por padrao ate o Bloco 7b. Ver o comentario no registro abaixo. */
  reembolsoHabilitado: boolean;
}

export function criarPaymentRouter(deps: PaymentRouterDeps): Router {
  const router = Router();

  // Toda rota de pagamento exige autenticacao. O middleware vem injetado para
  // que a rota seja testavel com um duble, sem fabricar JWT.
  router.use(deps.authMiddleware);

  router.post('/', (req, res, next) => {
    deps.controller.criar(req, res).catch(next);
  });


  // Desligada por padrao ate o Bloco 7b entregar o payment.refunded e o
  // consumidor no order-service. Mesmo criterio do PAYMENT_EXPIRATION_ENABLED:
  // efeito financeiro sem representacao a jusante fica indisponivel.
  //
  // A rota NAO e registrada, em vez de registrada com guarda: com a flag off a
  // funcionalidade nao existe, e 404 e a verdade. 503 prometeria que ela volta
  // sozinha, e quem a traz de volta e o 7b. Esta flag TEM data de morte.
  if (deps.reembolsoHabilitado) {
    // Plural: um pagamento pode ter varios reembolsos parciais, e POST na
    // colecao e o verbo de criar mais um. PATCH sugeriria editar um campo.
    router.post('/:id/refunds', deps.exigirAdmin, (req, res, next) => {
      deps.controller.reembolsar(req, res).catch(next);
    });
  } else {
    console.info(
      '[payment-service] rota de REEMBOLSO desativada (PAYMENT_REFUND_ENABLED != true). ' +
        'Ative apenas depois que payment.refunded tiver produtor e consumidor (Bloco 7b).',
    );
  }

  return router;
}
