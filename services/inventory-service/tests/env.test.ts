import { validateRequiredEnv, resolvePort } from '../src/config/env';

// Testes de validacao de ambiente no boot. Funcoes puras: passamos um env
// controlado como argumento e verificamos o comportamento, sem tocar no
// process.env real nem subir o servidor.
describe('config/env - validacao de ambiente', () => {
  describe('validateRequiredEnv', () => {
    it('passa quando todas as variaveis obrigatorias existem', () => {
      const env = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'segredo' };
      expect(() => validateRequiredEnv(env)).not.toThrow();
    });

    it('lanca quando falta DATABASE_URL', () => {
      const env = { JWT_SECRET: 'segredo' };
      expect(() => validateRequiredEnv(env)).toThrow('DATABASE_URL');
    });

    it('lanca quando falta JWT_SECRET', () => {
      const env = { DATABASE_URL: 'postgresql://x' };
      expect(() => validateRequiredEnv(env)).toThrow('JWT_SECRET');
    });
  });

  describe('resolvePort', () => {
    it('retorna a porta quando valida', () => {
      expect(resolvePort({ INVENTORY_PORT: '3004' })).toBe(3004);
    });

    it('usa o default 3004 quando INVENTORY_PORT ausente', () => {
      expect(resolvePort({})).toBe(3004);
    });

    it('lanca para porta nao-numerica', () => {
      expect(() => resolvePort({ INVENTORY_PORT: 'abc' })).toThrow('INVENTORY_PORT invalido');
    });

    it('lanca para porta fora do range (0)', () => {
      expect(() => resolvePort({ INVENTORY_PORT: '0' })).toThrow('INVENTORY_PORT invalido');
    });

    it('lanca para porta fora do range (acima de 65535)', () => {
      expect(() => resolvePort({ INVENTORY_PORT: '70000' })).toThrow('INVENTORY_PORT invalido');
    });
  });
});
