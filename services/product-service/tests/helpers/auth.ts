import jwt from 'jsonwebtoken';

// Gera um Bearer token valido, assinado com o MESMO segredo que o setup.ts
// fixou. O authMiddleware faz jwt.verify com process.env.JWT_SECRET, entao
// um token assinado aqui passa na verificacao real — sem mock do middleware.
export function authHeader(role: 'ADMIN' | 'SELLER' | 'BUYER'): string {
  const secret = process.env.JWT_SECRET as string;
  const token = jwt.sign(
    { id: 'test-user-id', email: 'teste@exemplo.com', role },
    secret,
    { expiresIn: '15m' }
  );
  return `Bearer ${token}`;
}

// Token estruturalmente valido, porem assinado com um segredo DIFERENTE.
// O jwt.verify deve rejeitar (assinatura nao confere) -> middleware retorna 401.
export function authHeaderWrongSecret(role: string = 'ADMIN'): string {
  const token = jwt.sign(
    { id: 'test-user-id', email: 'teste@exemplo.com', role },
    'segredo-errado-de-proposito',
    { expiresIn: '15m' }
  );
  return `Bearer ${token}`;
}

// Token assinado com o segredo certo, mas JA EXPIRADO (expiresIn negativo).
// O jwt.verify deve rejeitar por expiracao -> middleware retorna 401.
export function authHeaderExpired(role: string = 'ADMIN'): string {
  const secret = process.env.JWT_SECRET as string;
  const token = jwt.sign(
    { id: 'test-user-id', email: 'teste@exemplo.com', role },
    secret,
    { expiresIn: '-10s' }
  );
  return `Bearer ${token}`;
}
