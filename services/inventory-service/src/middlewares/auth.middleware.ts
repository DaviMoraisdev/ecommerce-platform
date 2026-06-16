import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface TokenPayload {
  id: string;
  email: string;
  role: string;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Token nao fornecido' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET as string) as TokenPayload;

    (req as any).userId = payload.id;
    (req as any).userRole = payload.role;

    next();
  } catch (error: any) {
    res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = (req as any).userRole;

    if (!userRole) {
      res.status(401).json({ error: 'Token nao fornecido ou invalido' });
      return;
    }

    if (!roles.includes(userRole)) {
      res.status(403).json({ error: 'Acesso negado', required: roles, current: userRole });
      return;
    }

    next();
  };
}
