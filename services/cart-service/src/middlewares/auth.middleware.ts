import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config/env';

interface TokenPayload {
  id: string;
  email: string;
  role: string;
}

// Valida estruturalmente o payload: precisa ser objeto e ter id string nao-vazia.
// Sem isso, um token assinado mas sem id passaria e viraria cart:undefined.
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
    // Usa o segredo validado no boot (loadConfig), nao process.env cru:
    // fonte unica de verdade para o JWT_SECRET.
    const payload = jwt.verify(token, loadConfig().jwtSecret);
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
