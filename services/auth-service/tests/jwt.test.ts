import { generateAccessToken, verifyAccessToken } from '../src/utils/jwt';

// Define variaveis de ambiente necessarias para o teste
process.env.JWT_SECRET = 'test_secret';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';

describe('JWT utils', () => {
  const payload = { id: '123', email: 'teste@teste.com', role: 'BUYER' };

  it('deve gerar um access token valido', () => {
    const token = generateAccessToken(payload);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('deve validar e decodificar o token gerado', () => {
    const token = generateAccessToken(payload);
    const decoded = verifyAccessToken(token);

    expect(decoded.id).toBe(payload.id);
    expect(decoded.email).toBe(payload.email);
    expect(decoded.role).toBe(payload.role);
  });

  it('deve lancar erro para token invalido', () => {
    expect(() => verifyAccessToken('token.invalido.aqui')).toThrow();
  });
});
