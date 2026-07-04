import jwt from 'jsonwebtoken';

// Gera um Bearer token valido para os testes, assinado com o MESMO segredo
// que o authMiddleware usa para verificar (process.env.JWT_SECRET, carregado
// do .env.test pelo setup.ts). Token assinado aqui passa na verificacao real —
// sem mock do middleware, exercitando a cadeia de auth de verdade.
export function authHeader(role: 'ADMIN' | 'SELLER' | 'BUYER'): string {
  const secret = process.env.JWT_SECRET as string;
  const token = jwt.sign(
    { id: 'test-user-id', email: 'teste@exemplo.com', role },
    secret,
    { expiresIn: '15m' }
  );
  return `Bearer ${token}`;
}
