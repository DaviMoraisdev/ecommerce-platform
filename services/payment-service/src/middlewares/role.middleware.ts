import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Exige uma role especifica, DEPOIS do authMiddleware.
 *
 * A claim `role` e OPCIONAL no token (`role?: string`), entao um token
 * perfeitamente valido chega aqui com `req.userRole === undefined`. Isso tem de
 * ser 403, e a comparacao estrita ja garante — mas o caso e testado
 * explicitamente, porque "funciona por acidente" e o que quebra na primeira
 * mudanca do formato do token.
 *
 * O corpo NAO revela qual role era exigida nem qual o token traz. O TECH_DEBT
 * ja registra esse vazamento como divida nos outros servicos (403 devolvendo
 * `required`/`current`); este endpoint nasce sem ele.
 */
export function exigirRole(role: string): RequestHandler {
  return function roleMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.userRole !== role) {
      res.status(403).json({ code: 'ACESSO_NEGADO', error: 'Acesso negado' });
      return;
    }
    next();
  };
}
