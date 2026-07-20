import { assertTestDatabase } from './helpers/testDbGuard';

const OLD_URL = process.env.DATABASE_URL;
const OLD_ENV = process.env.NODE_ENV;
const OLD_OPT = process.env.ALLOW_TEST_DB_RESET;

function setEnv(url: string, nodeEnv?: string, optIn?: string) {
  process.env.DATABASE_URL = url;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (optIn === undefined) delete process.env.ALLOW_TEST_DB_RESET;
  else process.env.ALLOW_TEST_DB_RESET = optIn;
}

afterEach(() => {
  process.env.DATABASE_URL = OLD_URL;
  process.env.NODE_ENV = OLD_ENV;
  process.env.ALLOW_TEST_DB_RESET = OLD_OPT;
});

const OK = 'postgresql://u:p@h:5432/order_test_db';

describe('assertTestDatabase', () => {
  it('passa com banco, NODE_ENV e opt-in corretos', () => {
    setEnv(OK, 'test', 'true');
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it('rejeita banco de nome parecido (order_test_db_backup)', () => {
    setEnv('postgresql://u:p@h:5432/order_test_db_backup', 'test', 'true');
    expect(() => assertTestDatabase()).toThrow();
  });

  it('rejeita quando o nome aparece so na senha', () => {
    setEnv('postgresql://u:order_test_db@h:5432/producao', 'test', 'true');
    expect(() => assertTestDatabase()).toThrow();
  });

  it('rejeita sem NODE_ENV=test', () => {
    setEnv(OK, 'development', 'true');
    expect(() => assertTestDatabase()).toThrow();
  });

  it('rejeita sem opt-in', () => {
    setEnv(OK, 'test', undefined);
    expect(() => assertTestDatabase()).toThrow();
  });

  it('rejeita URL invalida', () => {
    setEnv('nao-e-uma-url', 'test', 'true');
    expect(() => assertTestDatabase()).toThrow();
  });
});
