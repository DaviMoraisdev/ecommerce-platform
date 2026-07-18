import { sanitizeConnectionError } from '../src/config/database-error';

describe('sanitizeConnectionError', () => {
  it('mantem nomes de erro Prisma conhecidos', () => {
    const err = new Error('detalhe sensivel');
    err.name = 'PrismaClientInitializationError';
    expect(sanitizeConnectionError(err)).toBe(
      'Falha ao conectar ao banco de dados: PrismaClientInitializationError'
    );
  });
  it('generaliza nome de erro desconhecido', () => {
    const err = new Error('senha=123 host=interno');
    err.name = 'AlgumErroEstranhoComDadoSensivel';
    expect(sanitizeConnectionError(err)).toBe(
      'Falha ao conectar ao banco de dados: DatabaseConnectionError'
    );
  });
  it('trata valor que nao e Error', () => {
    expect(sanitizeConnectionError('string crua')).toBe(
      'Falha ao conectar ao banco de dados: DatabaseConnectionError'
    );
  });
});
