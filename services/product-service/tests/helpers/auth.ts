import jwt from 'jsonwebtoken';

// Gera um Bearer token valido para os testes, assinado com o MESMO segredo
// que o setup.ts fixou (test-secret-product-service). O authMiddleware do
// product-service faz jwt.verify com process.env.JWT_SECRET — entao um token
// assinado aqui com esse segredo passa na verificacao real, sem mock.
//
// O payload espelha o TokenPayload que o middleware espera (id, email, role).
// E o role que o requireRole usa para decidir 201 vs 403.
export function authHeader(role: 'ADMIN' | 'SELLER' | 'BUYER'): string {
  const secret = process.env.JWT_SECRET as string;
  const token = jwt.sign(
    { id: 'test-user-id', email: 'teste@exemplo.com', role },
    secret,
    { expiresIn: '15m' }
  );
  return `Bearer ${token}`;
}
