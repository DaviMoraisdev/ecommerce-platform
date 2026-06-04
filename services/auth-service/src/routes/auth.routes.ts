import { Router } from 'express';
import { register, login, refresh, me, adminListUsers } from '../controllers/auth.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.get('/me', authMiddleware, me);
router.get('/admin/users', authMiddleware, requireRole('ADMIN'), adminListUsers);

export default router;
