import { Router } from 'express';
import { authMiddleware, requireRole } from '../middlewares/auth.middleware';
import * as orderController from '../controllers/order.controller';

const router = Router();

// Todas as rotas exigem autenticacao.
router.use(authMiddleware);

// Criar pedido a partir do proprio carrinho (qualquer usuario logado).
router.post('/', orderController.create);

// Ver um pedido (dono ou ADMIN — checado no controller).
router.get('/:id', orderController.getOne);

// Mudar status: ADMIN/SELLER (operacao administrativa/logistica).
// O cancelamento pelo proprio cliente pode virar uma rota dedicada depois.
router.patch(
  '/:id/status',
  requireRole('ADMIN', 'SELLER'),
  orderController.changeStatus
);

export default router;
