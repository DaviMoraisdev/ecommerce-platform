import { assertTestDatabase, GuardaDeBancoError, BANCO_DE_TESTE } from './helpers/testDbGuard';

/**
 * A guarda recebe o ambiente por parametro, entao nenhum teste aqui muta
 * process.env — some a armadilha de `process.env.X = undefined` virar a
 * STRING 'undefined', e some o boilerplate de restauracao.
 */
function ambiente(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: `postgresql://u:SenhaSecreta@127.0.0.1:5432/${BANCO_DE_TESTE}`,
    NODE_ENV: 'test',
    ALLOW_TEST_DB_RESET: 'true',
    ...overrides,
  };
}

describe('assertTestDatabase', () => {
  it('passa com banco, NODE_ENV e opt-in corretos', () => {
    expect(() => assertTestDatabase(ambiente())).not.toThrow();
  });

  it.each(['127.0.0.1', 'localhost'])('aceita o host local %s', (host) => {
    expect(() =>
      assertTestDatabase(
        ambiente({ DATABASE_URL: `postgresql://u:p@${host}:5432/${BANCO_DE_TESTE}` }),
      ),
    ).not.toThrow();
  });

  it('rejeita banco de nome parecido (sufixo _backup)', () => {
    expect(() =>
      assertTestDatabase(
        ambiente({ DATABASE_URL: `postgresql://u:p@127.0.0.1:5432/${BANCO_DE_TESTE}_backup` }),
      ),
    ).toThrow(GuardaDeBancoError);
  });

  it('rejeita quando o nome do banco de teste aparece so na senha', () => {
    expect(() =>
      assertTestDatabase(
        ambiente({ DATABASE_URL: `postgresql://u:${BANCO_DE_TESTE}@127.0.0.1:5432/producao` }),
      ),
    ).toThrow(GuardaDeBancoError);
  });

  it.each([
    ['DATABASE_URL ausente', { DATABASE_URL: undefined }],
    ['DATABASE_URL vazia', { DATABASE_URL: '' }],
    ['DATABASE_URL so com espacos', { DATABASE_URL: '   ' }],
    ['DATABASE_URL malformada', { DATABASE_URL: 'nao-e-uma-url' }],
  ])('aborta quando %s', (_rotulo, override) => {
    expect(() => assertTestDatabase(ambiente(override as NodeJS.ProcessEnv))).toThrow(
      GuardaDeBancoError,
    );
  });

  it.each(['development', 'production', undefined])(
    'rejeita NODE_ENV=%s',
    (nodeEnv) => {
      expect(() => assertTestDatabase(ambiente({ NODE_ENV: nodeEnv }))).toThrow(
        GuardaDeBancoError,
      );
    },
  );

  it.each([undefined, 'false', '1', 'TRUE', 'yes'])(
    'rejeita ALLOW_TEST_DB_RESET=%s — so a string exata "true" autoriza',
    (optIn) => {
      expect(() => assertTestDatabase(ambiente({ ALLOW_TEST_DB_RESET: optIn }))).toThrow(
        GuardaDeBancoError,
      );
    },
  );

  it('rejeita host remoto sem opt-in', () => {
    expect(() =>
      assertTestDatabase(
        ambiente({ DATABASE_URL: `postgresql://u:p@db.producao.com:5432/${BANCO_DE_TESTE}` }),
      ),
    ).toThrow(/nao e local/);
  });

  it('aceita host remoto com ALLOW_REMOTE_TEST_DB=true', () => {
    expect(() =>
      assertTestDatabase(
        ambiente({
          DATABASE_URL: `postgresql://u:p@db.producao.com:5432/${BANCO_DE_TESTE}`,
          ALLOW_REMOTE_TEST_DB: 'true',
        }),
      ),
    ).not.toThrow();
  });

  it('aceita o host local IPv6', () => {
    expect(() =>
      assertTestDatabase(
        ambiente({ DATABASE_URL: `postgresql://u:p@[::1]:5432/${BANCO_DE_TESTE}` }),
      ),
    ).not.toThrow();
  });

  it.each(['1', 'TRUE', 'yes', 'false'])(
    'rejeita host remoto com ALLOW_REMOTE_TEST_DB=%s — so a string exata "true" autoriza',
    (valor) => {
      expect(() =>
        assertTestDatabase(
          ambiente({
            DATABASE_URL: `postgresql://u:p@db.producao.com:5432/${BANCO_DE_TESTE}`,
            ALLOW_REMOTE_TEST_DB: valor,
          }),
        ),
      ).toThrow(GuardaDeBancoError);
    },
  );

  it('nao vaza a senha na mensagem de erro', () => {
    // Capturar fora do catch. Na versao anterior, se a guarda NAO lancasse, o
    // proprio erro-sentinela era capturado — e a mensagem dele tambem nao
    // contem a senha, entao a assercao passava. Falso positivo: o teste
    // precisa provar as DUAS coisas, que recusou e que nao vazou.
    let capturado: unknown;

    try {
      assertTestDatabase(
        ambiente({ DATABASE_URL: 'postgresql://u:SenhaSecreta@127.0.0.1:5432/producao' }),
      );
    } catch (erro) {
      capturado = erro;
    }

    expect(capturado).toBeInstanceOf(GuardaDeBancoError);
    expect((capturado as Error).message).not.toContain('SenhaSecreta');
  });
});
