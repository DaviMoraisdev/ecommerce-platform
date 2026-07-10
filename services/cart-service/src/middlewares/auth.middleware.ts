import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface TokenPayload {
  id: string;
  email: string;
  role: string;
}

// Valida o JWT emitido pelo auth-service e injeta userId/userRole na request.
// Le JWT_SECRET em runtime (nao no topo do modulo) — mesma licao da Fase 3.
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Token nao fornecido' });
      return;
    }
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET as string
    ) as TokenPayload;
    (req as any).userId = payload.id;
    (req as any).userRole = payload.role;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}
