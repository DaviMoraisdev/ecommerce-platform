jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));
import amqp from 'amqplib';

process.env.RABBITMQ_URL = 'amqp://localhost:5672';
process.env.RABBITMQ_RETRY_DELAY_MS = '0';
process.env.RABBITMQ_PUBLISH_TIMEOUT_MS = '50';

const { initEventPublisher, publishEvent, closeEventPublisher } =
  require('../src/events/publisher') as typeof import('../src/events/publisher');

const connect = (amqp as unknown as { connect: jest.Mock }).connect;

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockReturnValue(true),
    waitForConfirms: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
function makeConnection(channel: unknown, overrides: Record<string, unknown> = {}) {
  return {
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('event publisher', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('publishEvent sem canal e no-op (nao lanca) e avisa', async () => {
    await expect(publishEvent('order.created', { a: 1 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('canal indisponivel'));
    expect(connect).not.toHaveBeenCalled();
  });

  it('initEventPublisher sem RABBITMQ_URL: avisa e nao conecta', async () => {
    const saved = process.env.RABBITMQ_URL;
    delete process.env.RABBITMQ_URL;
    await expect(initEventPublisher()).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RABBITMQ_URL nao definida'));
    process.env.RABBITMQ_URL = saved;
  });

  it('init com sucesso: publishEvent publica persistente e espera confirmacao', async () => {
    const channel = makeChannel();
    connect.mockResolvedValue(makeConnection(channel));

    await initEventPublisher();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(channel.assertExchange).toHaveBeenCalledWith('orders', 'topic', { durable: true });

    await publishEvent('order.created', { orderId: 'x' });
    const call = (channel.publish as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('orders');
    expect(call[1]).toBe('order.created');
    expect(Buffer.isBuffer(call[2])).toBe(true);
    expect(JSON.parse(call[2].toString())).toEqual({ orderId: 'x' });
    expect(call[3]).toMatchObject({ persistent: true });
    expect(channel.waitForConfirms).toHaveBeenCalled();
    await closeEventPublisher();
  });

  it('init esgota os retries e lanca quando o broker nao conecta', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(initEventPublisher()).rejects.toThrow('ECONNREFUSED');
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('init fecha a conexao se createConfirmChannel falha (sem vazar)', async () => {
    const conn = makeConnection(null, {
      createConfirmChannel: jest.fn().mockRejectedValue(new Error('chan fail')),
    });
    connect.mockResolvedValue(conn);
    await expect(initEventPublisher()).rejects.toThrow('chan fail');
    expect(conn.close).toHaveBeenCalled();
  });

  it('publishEvent: timeout na confirmacao nao pendura (loga e retorna)', async () => {
    const channel = makeChannel({
      waitForConfirms: jest.fn().mockReturnValue(new Promise(() => undefined)),
    });
    connect.mockResolvedValue(makeConnection(channel));
    await initEventPublisher();
    await expect(publishEvent('order.created', { a: 1 })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('falha ao publicar'));
    await closeEventPublisher();
  });

  it('closeEventPublisher chama close no canal e na conexao', async () => {
    const channel = makeChannel();
    const conn = makeConnection(channel);
    connect.mockResolvedValue(conn);
    await initEventPublisher();
    await closeEventPublisher();
    expect(channel.close).toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });
});
