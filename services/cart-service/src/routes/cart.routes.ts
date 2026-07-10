import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import * as cartController from '../controllers/cart.controller';

const router = Router();

// Todas as rotas do carrinho exigem usuario autenticado.
router.use(authMiddleware);

router.get('/', cartController.getCart);
router.post('/items', cartController.addItem);
router.patch('/items/:productId', cartController.updateItem);
router.delete('/items/:productId', cartController.removeItem);
router.delete('/', cartController.clearCart);

export default router;
