import { Request, Response, NextFunction } from 'express';

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = (req as any).userRole;

    if (!userRole) {
      res.status(401).json({ error: 'Token nao fornecido ou invalido' });
      return;
    }

    if (!roles.includes(userRole)) {
      res.status(403).json({
        error: 'Acesso negado',
        required: roles,
        current: userRole,
      });
      return;
    }

    next();
  };
}
