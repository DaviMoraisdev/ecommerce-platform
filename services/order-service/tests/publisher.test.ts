jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));
import amqp from 'amqplib';

process.env.RABBITMQ_URL = 'amqp://localhost:5672';
process.env.RABBITMQ_MAX_RETRIES = '2';
process.env.RABBITMQ_RETRY_DELAY_MS = '0';
process.env.RABBITMQ_CONNECT_TIMEOUT_MS = '30';
process.env.RABBITMQ_PUBLISH_TIMEOUT_MS = '50';
process.env.RABBITMQ_CLOSE_TIMEOUT_MS = '50';

const { initEventPublisher, publish, isPublisherReady, closeEventPublisher } =
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
  afterEach(async () => {
    await closeEventPublisher();
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('isPublisherReady: false quando nao ha canal', () => {
    expect(isPublisherReady()).toBe(false);
  });

  it('initEventPublisher sem RABBITMQ_URL: avisa e nao conecta', async () => {
    const saved = process.env.RABBITMQ_URL;
    delete process.env.RABBITMQ_URL;
    await expect(initEventPublisher()).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RABBITMQ_URL nao definida'));
    process.env.RABBITMQ_URL = saved;
  });

  it('init com sucesso: ready=true e publish confirma (persistente)', async () => {
    const channel = makeChannel();
    connect.mockResolvedValue(makeConnection(channel));
    await initEventPublisher();
    expect(isPublisherReady()).toBe(true);
    expect(channel.assertExchange).toHaveBeenCalledWith('orders', 'topic', { durable: true });

    const ok = await publish('order.created', { orderId: 'x' });
    expect(ok).toBe(true);
    const call = (channel.publish as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('orders');
    expect(call[1]).toBe('order.created');
    expect(Buffer.isBuffer(call[2])).toBe(true);
    expect(JSON.parse(call[2].toString())).toEqual({ orderId: 'x' });
    expect(call[3]).toMatchObject({ persistent: true });
    expect(channel.waitForConfirms).toHaveBeenCalled();
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

  it('conexao que resolve DEPOIS do timeout e fechada (nao vaza)', async () => {
    const lateConn = makeConnection(makeChannel());
    connect.mockImplementation(
      () => new Promise((res) => setTimeout(() => res(lateConn), 70))
    );
    await expect(initEventPublisher()).rejects.toThrow(/timeout/);
    await new Promise((r) => setTimeout(r, 160));
    expect(lateConn.close).toHaveBeenCalled();
  });

  it('publish: false quando nao ha canal', async () => {
    expect(await publish('order.created', { a: 1 })).toBe(false);
  });

  it('publish: timeout de confirmacao retorna false e desativa o canal', async () => {
    const channel = makeChannel({
      waitForConfirms: jest.fn().mockReturnValue(new Promise(() => undefined)),
    });
    connect.mockResolvedValue(makeConnection(channel));
    await initEventPublisher();

    expect(await publish('order.created', { a: 1 })).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('canal desativado'));
    expect(channel.close).toHaveBeenCalled();
    expect(isPublisherReady()).toBe(false);
    expect(await publish('order.created', { b: 2 })).toBe(false);
    expect((channel.publish as jest.Mock).mock.calls.length).toBe(1);
  });

  it('closeEventPublisher fecha canal e conexao e zera o estado', async () => {
    const channel = makeChannel();
    const conn = makeConnection(channel);
    connect.mockResolvedValue(conn);
    await initEventPublisher();
    await closeEventPublisher();
    expect(channel.close).toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
    expect(isPublisherReady()).toBe(false);
  });

  it('initEventPublisher e single-flight (concorrente = 1 connect)', async () => {
    let resolveConn!: (v: unknown) => void;
    connect.mockImplementation(
      () => new Promise((res) => {
        resolveConn = res;
      })
    );
    const p1 = initEventPublisher();
    const p2 = initEventPublisher();
    resolveConn(makeConnection(makeChannel()));
    await Promise.all([p1, p2]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('timeout desativa canal+conexao e reconecta no init seguinte', async () => {
    const ch1 = makeChannel({
      waitForConfirms: jest.fn().mockReturnValue(new Promise(() => undefined)),
    });
    const conn1 = makeConnection(ch1);
    const ch2 = makeChannel();
    const conn2 = makeConnection(ch2);
    connect.mockResolvedValueOnce(conn1).mockResolvedValueOnce(conn2);

    await initEventPublisher();
    expect(await publish('order.created', {})).toBe(false);
    expect(ch1.close).toHaveBeenCalled();
    expect(conn1.close).toHaveBeenCalled();
    expect(isPublisherReady()).toBe(false);

    await initEventPublisher();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(isPublisherReady()).toBe(true);
    expect(await publish('order.created', {})).toBe(true);
  });
});
