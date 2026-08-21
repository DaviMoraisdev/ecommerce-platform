jest.mock('amqplib', () => ({ __esModule: true, default: { connect: jest.fn() } }));

type Fn = (...args: unknown[]) => unknown;

/**
 * O publisher guarda estado em modulo (conexao, canal, connecting). Cada caso
 * precisa de um registro limpo, entao tudo e carregado por import dinamico apos
 * resetModules. Divida do desenho global registrada no TECH_DEBT.
 */
async function carregar(conexao: unknown, env: NodeJS.ProcessEnv = {}) {
  jest.resetModules();
  // Knobs sao lidos no import: encurta-los aqui evita esperar 33s de retry.
  for (const [k, v] of Object.entries(env)) process.env[k] = v as string;
  const amqp = (await import('amqplib')).default as unknown as { connect: jest.Mock };
  amqp.connect.mockReset();
  amqp.connect.mockResolvedValue(conexao);
  const mod = await import('../../../src/events/publisher');
  return { mod, amqp };
}

function montarCanal(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, Fn> = {};
  const canal = {
    handlers,
    assertExchange: jest.fn(async () => undefined),
    publish: jest.fn(() => true),
    waitForConfirms: jest.fn(async () => undefined),
    on: jest.fn((evento: string, h: Fn) => {
      handlers[evento] = h;
    }),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
  return canal;
}

function montarConexao(canal: unknown, overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, Fn> = {};
  return {
    handlers,
    createConfirmChannel: jest.fn(async () => canal),
    on: jest.fn((evento: string, h: Fn) => {
      handlers[evento] = h;
    }),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

let avisos: string[];
let erros: string[];

beforeEach(() => {
  avisos = [];
  erros = [];
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void avisos.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void erros.push(a.join(' ')));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const URL_BROKER = 'amqp://usuario:senha_supersecreta@broker:5672';

describe('publisher — caminho confirmado', () => {
  it('CASO P1: declara o exchange e confirma a publicacao', async () => {
    const canal = montarCanal();
    const { mod } = await carregar(montarConexao(canal));

    await mod.initEventPublisher(URL_BROKER);

    expect(canal.assertExchange).toHaveBeenCalledWith(
      'payments',
      'topic',
      { durable: true },
    );
    expect(mod.isPublisherReady()).toBe(true);
    await expect(mod.publish('payment.captured', { a: 1 })).resolves.toBe(true);
  });
});

describe('publisher — mensagem sem fila ligada', () => {
  it('CASO P2: mensagem NAO ROTEADA nao pode contar como publicada', async () => {
    // waitForConfirms confirma que o BROKER aceitou no exchange, nao que alguma
    // fila recebeu. Sem binding (o consumidor so existe no 5b), o RabbitMQ
    // descarta em silencio e a outbox marcaria SENT: evento perdido para sempre.
    const canal = montarCanal();
    canal.publish = jest.fn((..._args: unknown[]) => {
      const opcoes = _args[3] as { messageId?: string };
      // basic.return chega ANTES do confirm, conforme o protocolo.
      canal.handlers['return']?.({ properties: { messageId: opcoes.messageId } });
      return true;
    }) as unknown as typeof canal.publish;

    const { mod } = await carregar(montarConexao(canal));
    await mod.initEventPublisher(URL_BROKER);

    await expect(mod.publish('payment.captured', { a: 1 })).resolves.toBe(false);
  });

  it('CASO P3: publica com mandatory, senao o broker nunca devolve', async () => {
    const canal = montarCanal();
    const { mod } = await carregar(montarConexao(canal));
    await mod.initEventPublisher(URL_BROKER);
    await mod.publish('payment.captured', { a: 1 });

    const opcoes = (canal.publish as unknown as jest.Mock).mock.calls[0][3] as Record<string, unknown>;
    expect(opcoes.mandatory).toBe(true);
    expect(opcoes.persistent).toBe(true);
    expect(typeof opcoes.messageId).toBe('string');
  });
});

describe('publisher — deadline da inicializacao', () => {
  it('CASO P4: canal que nao responde nao pendura o publisher para sempre', async () => {
    // Só o connect tinha deadline. Com createConfirmChannel pendurado, connecting
    // ficava preenchido e o unico ciclo do relay travava ate reiniciar o processo.
    const conexao = montarConexao(montarCanal(), {
      createConfirmChannel: jest.fn(() => new Promise(() => undefined)),
    });
    const { mod } = await carregar(conexao, { RABBITMQ_MAX_RETRIES: '1', RABBITMQ_CONNECT_TIMEOUT_MS: '50' });

    await expect(mod.initEventPublisher(URL_BROKER)).rejects.toThrow();
    expect(mod.isPublisherReady()).toBe(false);
  }, 5_000);
});

describe('publisher — falha isolada do canal', () => {
  it('CASO P5: erro no canal invalida o publisher e nao derruba o processo', async () => {
    const canal = montarCanal();
    const { mod } = await carregar(montarConexao(canal));
    await mod.initEventPublisher(URL_BROKER);
    expect(mod.isPublisherReady()).toBe(true);

    // Sem listener, um evento error de EventEmitter derruba o processo.
    expect(canal.handlers['error']).toBeDefined();
    canal.handlers['error']?.(new Error('canal caiu'));

    expect(mod.isPublisherReady()).toBe(false);
  });
});

describe('publisher — encerramento durante conexao', () => {
  it('CASO P6: init tardia NAO ressuscita um publisher ja fechado', async () => {
    let liberar: ((v: unknown) => void) | null = null;
    const canal = montarCanal();
    const conexao = montarConexao(canal, {
      createConfirmChannel: jest.fn(
        () => new Promise((r) => {
          liberar = r as (v: unknown) => void;
        }),
      ),
    });
    const { mod } = await carregar(conexao);

    const emVoo = mod.initEventPublisher(URL_BROKER).catch(() => undefined);
    await mod.closeEventPublisher();
    if (liberar !== null) (liberar as (v: unknown) => void)(canal);
    await emVoo;

    // Um publisher que volta a existir depois do shutdown quebra a ordem de
    // encerramento: o tick poderia rodar com o banco ja desconectado.
    expect(mod.isPublisherReady()).toBe(false);
  }, 5_000);
});

describe('publisher — log', () => {
  it('CASO P7: erro de conexao nao vaza a credencial da URL', async () => {
    jest.resetModules();
    const amqp = (await import('amqplib')).default as unknown as { connect: jest.Mock };
    amqp.connect.mockReset();
    process.env.RABBITMQ_MAX_RETRIES = '1';
    amqp.connect.mockRejectedValue(
      new Error('connect ECONNREFUSED ' + URL_BROKER),
    );
    const mod = await import('../../../src/events/publisher');

    await expect(mod.initEventPublisher(URL_BROKER)).rejects.toThrow();

    // A credencial viaja DENTRO da URL do broker, e log operacional e lido por
    // muita gente. Mesma regra do testDbGuard e do sanitizeConnectionError.
    expect(avisos.join(' ')).not.toContain('senha_supersecreta');
    expect(erros.join(' ')).not.toContain('senha_supersecreta');
  }, 5_000);
});
