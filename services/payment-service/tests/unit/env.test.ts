import { loadConfig, ConfigError } from '../../src/config/env';

const base: NodeJS.ProcessEnv = {
  PAYMENT_PORT: '3007',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/payment_db',
  DEFAULT_CURRENCY: 'BRL',
};

describe('loadConfig', () => {
  it('monta a config a partir de um ambiente valido', () => {
    expect(loadConfig(base)).toEqual({
      port: 3007,
      databaseUrl: 'postgresql://u:p@127.0.0.1:5432/payment_db',
      defaultCurrency: 'BRL',
    });
  });

  it('assume BRL quando DEFAULT_CURRENCY nao e informada', () => {
    const { DEFAULT_CURRENCY, ...semMoeda } = base;
    expect(loadConfig(semMoeda).defaultCurrency).toBe('BRL');
  });

  it('remove espacos ao redor dos valores', () => {
    expect(loadConfig({ ...base, PAYMENT_PORT: '  3007  ' }).port).toBe(3007);
  });

  it.each(['PAYMENT_PORT', 'DATABASE_URL'])(
    'lanca quando %s esta ausente',
    (chave) => {
      const semChave = { ...base };
      delete semChave[chave];
      expect(() => loadConfig(semChave)).toThrow(ConfigError);
    },
  );

  it.each(['PAYMENT_PORT', 'DATABASE_URL'])(
    'lanca quando %s esta vazia ou so com espacos',
    (chave) => {
      expect(() => loadConfig({ ...base, [chave]: '   ' })).toThrow(ConfigError);
    },
  );

  it.each(['0', '65536', '-1', 'abc', '3007.5', ''])(
    'lanca para PAYMENT_PORT invalida "%s"',
    (porta) => {
      expect(() => loadConfig({ ...base, PAYMENT_PORT: porta })).toThrow(ConfigError);
    },
  );

  it.each(['1', '65535'])('aceita a porta limite %s', (porta) => {
    expect(loadConfig({ ...base, PAYMENT_PORT: porta }).port).toBe(Number(porta));
  });

  it('lanca para moeda nao suportada', () => {
    expect(() => loadConfig({ ...base, DEFAULT_CURRENCY: 'USD' })).toThrow(ConfigError);
  });
});
