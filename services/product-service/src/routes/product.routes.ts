import { Router } from 'express';
import * as productController from '../controllers/product.controller';
import { authMiddleware, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Leitura publica
router.get('/', productController.findAll);
router.get('/:id', productController.findOne);

// Escrita protegida: apenas ADMIN e SELLER
router.post('/', authMiddleware, requireRole('ADMIN', 'SELLER'), productController.create);
router.put('/:id', authMiddleware, requireRole('ADMIN', 'SELLER'), productController.update);
router.delete('/:id', authMiddleware, requireRole('ADMIN', 'SELLER'), productController.remove);

export default router;
