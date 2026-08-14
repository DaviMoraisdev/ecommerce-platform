import { validateRequiredEnv, resolvePort } from '../src/config/env';

// Testes de validacao de ambiente no boot. Funcoes puras: passamos um env
// controlado como argumento e verificamos o comportamento, sem tocar no
// process.env real nem subir o servidor.
describe('config/env - validacao de ambiente', () => {
  describe('validateRequiredEnv', () => {
    it('passa quando todas as variaveis obrigatorias existem', () => {
      const env = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718' };
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

describe('JWT_SECRET — placeholder e forca', () => {
  const FORTE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

  // O cenario do achado de seguranca: alguem copia o .env.example e sobe em
  // DESENVOLVIMENTO. Recusar so em producao nao pegaria este caso.
  it.each([
    'troque_este_segredo',
    'dev_jwt_secret_troque_em_producao',
    'sua_chave_secreta_aqui',
    'changeme',
    'secret',
    'segredo',
  ])('recusa o placeholder %p em desenvolvimento', (placeholder) => {
    expect(() => chamar(placeholder, 'development')).toThrow(/placeholder/i);
  });

  it('recusa placeholder ignorando caixa e espacos', () => {
    expect(() => chamar('  TROQUE_ESTE_SEGREDO  ', 'development')).toThrow(/placeholder/i);
  });

  it('aceita segredo forte em qualquer ambiente', () => {
    expect(() => chamar(FORTE, 'development')).not.toThrow();
    expect(() => chamar(FORTE, 'production')).not.toThrow();
  });

  it('em DESENVOLVIMENTO aceita segredo curto que nao e placeholder', () => {
    expect(() => chamar('curto_mas_proprio', 'development')).not.toThrow();
  });

  it('em PRODUCAO recusa segredo com menos de 32 caracteres', () => {
    expect(() => chamar('curto_mas_proprio', 'production')).toThrow(/32 caracteres/);
  });

  it('em PRODUCAO aceita exatamente 32 caracteres', () => {
    expect(() => chamar('a'.repeat(32), 'production')).not.toThrow();
  });
});

function chamar(s: string, e: string): void {
  validateRequiredEnv({ DATABASE_URL: 'postgresql://x', JWT_SECRET: s, NODE_ENV: e });
}
