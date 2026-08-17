import type { Server } from 'node:http';
import { bootstrap, type BootstrapDeps } from '../../src/bootstrap';
import type { AppConfig } from '../../src/config/env';

const CONFIG: AppConfig = {
  port: 3007,
  databaseUrl: 'postgresql://u:p@127.0.0.1:5432/payment_db',
  defaultCurrency: 'BRL',
  nodeEnv: 'test',
  provider: 'fake',
  webhookSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
  jwtSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
};

function montarDeps(ordem: string[], overrides: Partial<BootstrapDeps> = {}) {
  const listen = jest.fn((_porta: number, callback?: () => void) => {
    ordem.push('listen');
    callback?.();
    return {} as Server;
  });

  const deps: BootstrapDeps = {
    loadConfig: jest.fn(() => {
      ordem.push('config');
      return CONFIG;
    }),
    connectDatabase: jest.fn(async () => {
      ordem.push('connect');
    }),
    createApp: jest.fn(() => ({ listen })),
    ...overrides,
  };

  return { deps, listen };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('bootstrap', () => {
  it('executa na ordem: configuracao, conexao, porta', async () => {
    const ordem: string[] = [];
    const { deps } = montarDeps(ordem);

    await bootstrap(deps);

    expect(ordem).toEqual(['config', 'connect', 'listen']);
  });

  it('passa ao banco a URL vinda da configuracao validada', async () => {
    const ordem: string[] = [];
    const { deps } = montarDeps(ordem);

    await bootstrap(deps);

    expect(deps.connectDatabase).toHaveBeenCalledWith(CONFIG.databaseUrl);
  });

  it('NAO abre a porta quando a configuracao e invalida', async () => {
    const ordem: string[] = [];
    const { deps, listen } = montarDeps(ordem, {
      loadConfig: jest.fn(() => {
        throw new Error('PAYMENT_PORT invalida');
      }),
    });

    await expect(bootstrap(deps)).rejects.toThrow('PAYMENT_PORT invalida');

    expect(deps.connectDatabase).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('NAO abre a porta quando a conexao com o banco falha', async () => {
    const ordem: string[] = [];
    const { deps, listen } = montarDeps(ordem, {
      connectDatabase: jest.fn(async () => {
        throw new Error('Falha ao conectar ao banco de dados: DatabaseConnectionError');
      }),
    });

    await expect(bootstrap(deps)).rejects.toThrow('Falha ao conectar');

    expect(deps.createApp).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});
