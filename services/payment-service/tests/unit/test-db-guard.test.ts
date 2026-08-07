import { assertBancoDeTeste, GuardaDeBancoError, BANCO_DE_TESTE } from '../test-db-guard';

const URL_VALIDA = `postgresql://u:SenhaSecreta@127.0.0.1:5432/${BANCO_DE_TESTE}`;

describe('assertBancoDeTeste', () => {
  it.each(['127.0.0.1', 'localhost'])('aceita o banco de teste em %s', (host) => {
    expect(() =>
      assertBancoDeTeste({ DATABASE_URL: `postgresql://u:p@${host}:5432/${BANCO_DE_TESTE}` }),
    ).not.toThrow();
  });

  it.each([
    ['DATABASE_URL ausente', {}],
    ['DATABASE_URL vazia', { DATABASE_URL: '' }],
    ['DATABASE_URL so com espacos', { DATABASE_URL: '   ' }],
    ['DATABASE_URL malformada', { DATABASE_URL: 'nao-e-uma-url' }],
  ])('aborta quando %s', (_rotulo, env) => {
    expect(() => assertBancoDeTeste(env as NodeJS.ProcessEnv)).toThrow(GuardaDeBancoError);
  });

  it('aborta quando o banco alvo e o de desenvolvimento', () => {
    expect(() =>
      assertBancoDeTeste({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/payment_db' }),
    ).toThrow(/payment_db.*esperado.*payment_test_db/s);
  });

  it('aborta para host remoto sem opt-in explicito', () => {
    expect(() =>
      assertBancoDeTeste({ DATABASE_URL: `postgresql://u:p@db.producao.com:5432/${BANCO_DE_TESTE}` }),
    ).toThrow(/nao e local/);
  });

  it('permite host remoto com INTEGRATION_ALLOW_REMOTE=true', () => {
    expect(() =>
      assertBancoDeTeste({
        DATABASE_URL: `postgresql://u:p@db.producao.com:5432/${BANCO_DE_TESTE}`,
        INTEGRATION_ALLOW_REMOTE: 'true',
      }),
    ).not.toThrow();
  });

  it('nao aceita opt-in por valor truthy qualquer', () => {
    expect(() =>
      assertBancoDeTeste({
        DATABASE_URL: `postgresql://u:p@db.producao.com:5432/${BANCO_DE_TESTE}`,
        INTEGRATION_ALLOW_REMOTE: '1',
      }),
    ).toThrow(GuardaDeBancoError);
  });

  it('nao vaza a senha na mensagem de erro', () => {
    try {
      assertBancoDeTeste({ DATABASE_URL: URL_VALIDA.replace(BANCO_DE_TESTE, 'payment_db') });
      throw new Error('esperava que a guarda abortasse');
    } catch (erro) {
      expect((erro as Error).message).not.toContain('SenhaSecreta');
    }
  });
});
