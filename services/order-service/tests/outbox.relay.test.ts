jest.mock('../src/events/publisher');
jest.mock('../src/events/outbox.repository');
import * as publisher from '../src/events/publisher';
import * as outbox from '../src/events/outbox.repository';

process.env.OUTBOX_POLL_INTERVAL_MS = '50';
process.env.OUTBOX_STOP_TIMEOUT_MS = '50';

const { tick, startOutboxRelay, stopOutboxRelay } =
  require('../src/events/outbox.relay') as typeof import('../src/events/outbox.relay');

const isReady = publisher.isPublisherReady as jest.Mock;
const doPublish = publisher.publish as jest.Mock;
const doInit = publisher.initEventPublisher as jest.Mock;
const fetchPending = outbox.fetchPending as jest.Mock;
const markSent = outbox.markSent as jest.Mock;
const markRetry = outbox.markRetry as jest.Mock;

describe('outbox.relay', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await stopOutboxRelay();
    jest.restoreAllMocks();
  });

  it('broker fora (init falha): pula sem buscar, nao penaliza eventos', async () => {
    isReady.mockReturnValue(false);
    doInit.mockRejectedValue(new Error('down'));
    await tick();
    expect(fetchPending).not.toHaveBeenCalled();
    expect(markRetry).not.toHaveBeenCalled();
  });

  it('ready: publica pendentes e marca SENT', async () => {
    isReady.mockReturnValue(true);
    fetchPending.mockResolvedValue([
      { id: '1', routingKey: 'order.created', payload: { x: 1 }, attempts: 0 },
    ]);
    doPublish.mockResolvedValue(true);
    await tick();
    expect(doPublish).toHaveBeenCalledWith('order.created', { x: 1 });
    expect(markSent).toHaveBeenCalledWith('1');
    expect(markRetry).not.toHaveBeenCalled();
  });

  it('publish falha: markRetry mantem o evento (sem abandonar)', async () => {
    isReady.mockReturnValue(true);
    fetchPending.mockResolvedValue([
      { id: '1', routingKey: 'order.created', payload: {}, attempts: 5 },
    ]);
    doPublish.mockResolvedValue(false);
    await tick();
    expect(markRetry).toHaveBeenCalledWith('1', expect.any(String));
    expect(markSent).not.toHaveBeenCalled();
  });

  it('markSent falha apos publish ok: nao lanca e nao marca (evento fica recuperavel)', async () => {
    isReady.mockReturnValue(true);
    fetchPending.mockResolvedValue([
      { id: '1', routingKey: 'order.created', payload: {}, attempts: 0 },
    ]);
    doPublish.mockResolvedValue(true);
    markSent.mockRejectedValue(new Error('db down'));
    await expect(tick()).resolves.toBeUndefined();
    expect(markSent).toHaveBeenCalledWith('1');
  });

  it('startOutboxRelay e idempotente (loga inicio uma vez)', async () => {
    isReady.mockReturnValue(false);
    doInit.mockRejectedValue(new Error('down'));
    startOutboxRelay();
    startOutboxRelay();
    await new Promise((r) => setTimeout(r, 10));
    const inicios = log.mock.calls.filter((c) => String(c[0]).includes('outbox relay iniciado'));
    expect(inicios).toHaveLength(1);
  });

  it('stopOutboxRelay aguarda o tick em andamento', async () => {
    isReady.mockReturnValue(true);
    let resolvePublish!: (v: boolean) => void;
    fetchPending.mockResolvedValue([
      { id: '1', routingKey: 'order.created', payload: {}, attempts: 0 },
    ]);
    doPublish.mockReturnValue(
      new Promise<boolean>((res) => {
        resolvePublish = res;
      })
    );
    markSent.mockResolvedValue(undefined);

    startOutboxRelay();
    await new Promise((r) => setTimeout(r, 10));
    let done = false;
    const stopP = stopOutboxRelay().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    resolvePublish(true);
    await stopP;
    expect(done).toBe(true);
    expect(markSent).toHaveBeenCalledWith('1');
  });

  it('stopOutboxRelay respeita o teto se o tick travar', async () => {
    isReady.mockReturnValue(true);
    fetchPending.mockResolvedValue([
      { id: '1', routingKey: 'order.created', payload: {}, attempts: 0 },
    ]);
    doPublish.mockReturnValue(new Promise(() => undefined)); // nunca resolve
    startOutboxRelay();
    await new Promise((r) => setTimeout(r, 10));
    const inicio = Date.now();
    await stopOutboxRelay();
    expect(Date.now() - inicio).toBeLessThan(1000);
  });
});
