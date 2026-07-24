import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface TokenPayload {
  id: string;
  email?: string;
  role?: string;
}

// Valida o shape minimo: id string nao-vazia (evita userId undefined).
function isValidPayload(p: unknown): p is TokenPayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { id?: unknown }).id === 'string' &&
    (p as { id: string }).id.trim() !== ''
  );
}

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
    const payload = jwt.verify(token, process.env.JWT_SECRET as string);
    if (!isValidPayload(payload)) {
      res.status(401).json({ error: 'Token sem claims obrigatorias' });
      return;
    }
    (req as any).userId = payload.id;
    (req as any).userRole = payload.role;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = (req as any).userRole;
    if (!userRole) {
      res.status(401).json({ error: 'Nao autenticado' });
      return;
    }
    // 403 generico: nao vaza required/current (correcao que o TECH_DEBT pede).
    if (!roles.includes(userRole)) {
      res.status(403).json({ error: 'Acesso negado' });
      return;
    }
    next();
  };
}
