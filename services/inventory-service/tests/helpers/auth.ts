import jwt from 'jsonwebtoken';

// Fail-fast: se o JWT_SECRET nao estiver no ambiente (ex: CI sem a env, ou
// .env.test incompleto), falha AQUI com mensagem clara — em vez de assinar com
// undefined e fazer os testes de autorizacao quebrarem com um 401 obscuro.
const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error(
    'JWT_SECRET ausente no ambiente de teste. Configure no .env.test ' +
    '(veja .env.test.example) ou nas variaveis do CI.'
  );
}

// Gera um Bearer token valido, assinado com o MESMO segredo que o authMiddleware
// usa para verificar. Token assinado aqui passa na verificacao real — sem mock
// do middleware, exercitando a cadeia de auth de verdade.
export function authHeader(role: 'ADMIN' | 'SELLER' | 'BUYER'): string {
  const token = jwt.sign(
    { id: 'test-user-id', email: 'teste@exemplo.com', role },
    secret as string,
    { expiresIn: '15m' }
  );
  return `Bearer ${token}`;
}
