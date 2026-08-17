/**
 * Estende o Request do Express com o usuario autenticado.
 *
 * Os outros servicos usam `(req as any).userId`, que o TECH_DEBT registra como
 * refatoracao transversal pendente ("Estender o tipo Request do Express,
 * eliminando (req as any).userId/userRole"). O payment nasce sem o cast.
 *
 * Os campos sao OPCIONAIS de proposito: o tipo nao pode prometer que o
 * middleware rodou. Quem le precisa checar — e essa checagem e defesa em
 * profundidade, nao burocracia.
 */
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
    }
  }
}

export {};
