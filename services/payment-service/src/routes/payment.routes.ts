import { Router, type RequestHandler } from 'express';

import type { PaymentController } from '../controllers/payment.controller';

export interface PaymentRouterDeps {
  authMiddleware: RequestHandler;
  controller: PaymentController;
  /** Injetado como o authMiddleware, pelo mesmo motivo: testavel com duble. */
  exigirAdmin: RequestHandler;
}

export function criarPaymentRouter(deps: PaymentRouterDeps): Router {
  const router = Router();

  // Toda rota de pagamento exige autenticacao. O middleware vem injetado para
  // que a rota seja testavel com um duble, sem fabricar JWT.
  router.use(deps.authMiddleware);

  router.post('/', (req, res, next) => {
    deps.controller.criar(req, res).catch(next);
  });

  // Plural: um pagamento pode ter varios reembolsos parciais, e POST na colecao
  // e o verbo de criar mais um. PATCH no pagamento sugeriria editar um campo.
  router.post('/:id/refunds', deps.exigirAdmin, (req, res, next) => {
    deps.controller.reembolsar(req, res).catch(next);
  });

  return router;
}
