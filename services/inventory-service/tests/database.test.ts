import { sanitizeConnectionError } from '../src/config/database-error';

describe('sanitizeConnectionError', () => {
  it('nao expoe a connection string nem a senha vinda do .message', () => {
    const leaky = new Error(
      'Connection failed: postgresql://postgres:s3nh4Secreta@127.0.0.1:5432/inventory_db'
    );
    leaky.name = 'PrismaClientInitializationError';

    const output = sanitizeConnectionError(leaky);

    expect(output).not.toContain('s3nh4Secreta');
    expect(output).not.toContain('postgresql://');
    expect(output).not.toContain('127.0.0.1');
    expect(output).toContain('PrismaClientInitializationError');
  });

  it('nao vaza segredo injetado no error.name', () => {
    const leaky = new Error('safe');
    leaky.name = 'postgresql://user:s3nh4Secreta@host/db';

    const output = sanitizeConnectionError(leaky);

    expect(output).not.toContain('s3nh4Secreta');
    expect(output).not.toContain('postgresql://');
    expect(output).toContain('DatabaseConnectionError');
  });

  it('lida com valor que nao e Error sem vazar nem quebrar', () => {
    const output = sanitizeConnectionError('postgresql://user:senha@host/db');
    expect(output).not.toContain('senha');
    expect(output).toContain('DatabaseConnectionError');
  });
});
