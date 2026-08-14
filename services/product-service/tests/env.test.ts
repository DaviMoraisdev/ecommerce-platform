import { validateRequiredEnv } from '../src/config/env';

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
  validateRequiredEnv({ MONGO_URI: 'mongodb://x', JWT_SECRET: s, NODE_ENV: e });
}
