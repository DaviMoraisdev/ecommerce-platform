import type { Server } from 'node:http';
import { bootstrap, type BootstrapDeps } from '../../src/bootstrap';
import type { AppConfig } from '../../src/config/env';
import { configDeTeste } from '../helpers/config';

const CONFIG: AppConfig = configDeTeste();

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
    iniciarRelay: jest.fn(() => {
      ordem.push('relay');
    }),
    ...overrides,
  };

  return { deps, listen };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('bootstrap', () => {
  it('executa na ordem: configuracao, conexao, relay, porta', async () => {
    const ordem: string[] = [];
    const { deps } = montarDeps(ordem);

    await bootstrap(deps);

    // O relay entra DEPOIS do banco porque o ciclo dele le a outbox, e ANTES
    // da porta porque nao depende de HTTP — atrasar a saida de eventos ate o
    // servidor subir nao traz beneficio nenhum.
    expect(ordem).toEqual(['config', 'connect', 'relay', 'listen']);
  });

  it('passa ao banco a URL vinda da configuracao validada', async () => {
    const ordem: string[] = [];
    const { deps } = montarDeps(ordem);

    await bootstrap(deps);

    expect(deps.connectDatabase).toHaveBeenCalledWith(CONFIG.databaseUrl);
  });

  it('passa ao createApp a configuracao validada', async () => {
    const ordem: string[] = [];
    const { deps } = montarDeps(ordem);

    await bootstrap(deps);

    // Sem esta assercao, esquecer de repassar a config compilaria: em
    // TypeScript uma funcao com MENOS parametros e atribuivel a um tipo que
    // espera mais. O typecheck nao cobre este erro; o teste cobre.
    expect(deps.createApp).toHaveBeenCalledWith(CONFIG);
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

describe('bootstrap — relay da outbox', () => {
  it('NAO inicia o relay quando a conexao com o banco falha', async () => {
    const ordem: string[] = [];
    const { deps } = montarDeps(ordem, {
      connectDatabase: jest.fn(async () => {
        throw new Error('Falha ao conectar ao banco de dados');
      }),
    });
    await expect(bootstrap(deps)).rejects.toThrow('Falha ao conectar');
    expect(deps.iniciarRelay).not.toHaveBeenCalled();
  });

  it('passa ao relay a configuracao validada', async () => {
    const ordem: string[] = [];
    const { deps } = montarDeps(ordem);
    await bootstrap(deps);
    expect(deps.iniciarRelay).toHaveBeenCalledWith(CONFIG);
  });
});
