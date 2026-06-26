import { sanitizeConnectionError } from '../src/config/database';

describe('sanitizeConnectionError', () => {
  it('nao expoe a connection string nem a senha no log', () => {
    // Pior caso: um erro cujo .message carrega a DATABASE_URL completa.
    const leaky = new Error(
      'Connection failed: postgresql://postgres:s3nh4Secreta@127.0.0.1:5432/inventory_db'
    );
    leaky.name = 'PrismaClientInitializationError';

    const output = sanitizeConnectionError(leaky);

    expect(output).not.toContain('s3nh4Secreta');
    expect(output).not.toContain('postgresql://');
    expect(output).not.toContain('127.0.0.1');
    // Ainda precisa ser util: deve dizer QUE classe de erro ocorreu.
    expect(output).toContain('PrismaClientInitializationError');
  });

  it('lida com valor que nao e Error sem vazar nem quebrar', () => {
    const output = sanitizeConnectionError('postgresql://user:senha@host/db');
    expect(output).not.toContain('senha');
    expect(output).toContain('UnknownError');
  });
});