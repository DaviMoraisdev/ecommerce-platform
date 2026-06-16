import { Router } from 'express';
import * as stockController from '../controllers/stock.controller';
import { authMiddleware, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Consulta de disponibilidade: publica (o catalogo precisa ler)
router.get('/:productId', stockController.getAvailability);

// Definir estoque: apenas ADMIN e SELLER
router.post('/', authMiddleware, requireRole('ADMIN', 'SELLER'), stockController.setStock);

// Reservar e liberar: exigem autenticacao (serao chamados por outros servicos/usuarios logados)
router.post('/reserve', authMiddleware, stockController.reserve);
router.post('/release', authMiddleware, requireRole('ADMIN', 'SELLER'), stockController.release);

export default router;
