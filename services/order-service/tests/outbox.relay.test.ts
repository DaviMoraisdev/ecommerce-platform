jest.mock('../src/events/publisher');
jest.mock('../src/events/outbox.repository');
import * as publisher from '../src/events/publisher';
import * as outbox from '../src/events/outbox.repository';
import { tick } from '../src/events/outbox.relay';

const isReady = publisher.isPublisherReady as jest.Mock;
const doPublish = publisher.publish as jest.Mock;
const doInit = publisher.initEventPublisher as jest.Mock;
const fetchPending = outbox.fetchPending as jest.Mock;
const markSent = outbox.markSent as jest.Mock;
const markRetry = outbox.markRetry as jest.Mock;

describe('outbox.relay tick', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
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

  it('publish falha: markRetry com o attempts atual', async () => {
    isReady.mockReturnValue(true);
    fetchPending.mockResolvedValue([
      { id: '1', routingKey: 'order.created', payload: {}, attempts: 2 },
    ]);
    doPublish.mockResolvedValue(false);
    await tick();
    expect(markRetry).toHaveBeenCalledWith('1', 2, expect.any(String));
    expect(markSent).not.toHaveBeenCalled();
  });
});
