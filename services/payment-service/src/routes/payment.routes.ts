import { Router, type RequestHandler } from 'express';

import type { PaymentController } from '../controllers/payment.controller';

export interface PaymentRouterDeps {
  authMiddleware: RequestHandler;
  controller: PaymentController;
}

export function criarPaymentRouter(deps: PaymentRouterDeps): Router {
  const router = Router();

  // Toda rota de pagamento exige autenticacao. O middleware vem injetado para
  // que a rota seja testavel com um duble, sem fabricar JWT.
  router.use(deps.authMiddleware);

  router.post('/', (req, res, next) => {
    deps.controller.criar(req, res).catch(next);
  });

  return router;
}
