import {
  parseEvent,
  decideMessage,
  handleEvent,
  sanitizeForLog,
  handleDelivery,
  executeAction,
} from '../src/consumer';

const base = { eventId: 'e1' };
const validRaw = JSON.stringify({ ...base, type: 'order.created', orderId: 'o1', total: 10 });

describe('parseEvent', () => {
  it('aceita order.created valido', () => {
    const raw = JSON.stringify({ ...base, type: 'order.created', orderId: 'o1', userId: 'u1', total: 30 });
    expect(parseEvent(raw)).toMatchObject({ type: 'order.created', orderId: 'o1', total: 30, eventId: 'e1' });
  });

  it('aceita order.status_changed valido', () => {
    const raw = JSON.stringify({ ...base, type: 'order.status_changed', orderId: 'o1', status: 'PAGO' });
    expect(parseEvent(raw)).toMatchObject({ type: 'order.status_changed', orderId: 'o1', status: 'PAGO' });
  });

  it('rejeita JSON malformado', () => {
    expect(parseEvent('{ invalido')).toBeNull();
  });

  it('rejeita sem eventId', () => {
    expect(parseEvent(JSON.stringify({ type: 'order.created', orderId: 'o1', total: 1 }))).toBeNull();
  });

  it('rejeita eventId com espaco periferico (nao canonico)', () => {
    expect(parseEvent(JSON.stringify({ type: 'order.created', eventId: 'e1 ', orderId: 'o1', total: 1 }))).toBeNull();
  });

  it('rejeita eventId muito longo (cap de tamanho)', () => {
    expect(parseEvent(JSON.stringify({ type: 'order.created', eventId: 'x'.repeat(200), orderId: 'o1', total: 1 }))).toBeNull();
  });

  it('rejeita sem type', () => {
    expect(parseEvent(JSON.stringify({ ...base, orderId: 'o1' }))).toBeNull();
  });

  it('rejeita sem orderId', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.created', total: 1 }))).toBeNull();
  });

  it('rejeita order.created sem total', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.created', orderId: 'o1' }))).toBeNull();
  });

  it('rejeita order.status_changed sem status', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.status_changed', orderId: 'o1' }))).toBeNull();
  });

  it('rejeita schema incorreto: total como string', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.created', orderId: 'o1', total: 'trinta' }))).toBeNull();
  });

  it('rejeita schema incorreto: orderId numero', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.created', orderId: 123, total: 1 }))).toBeNull();
  });

  it('rejeita nao-objeto', () => {
    expect(parseEvent(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseEvent(JSON.stringify(42))).toBeNull();
  });
});

describe('decideMessage', () => {
  it('ack quando routing key casa', () => {
    const d = decideMessage(validRaw, 'order.created');
    expect(d.ack).toBe(true);
    expect(d.event).toMatchObject({ orderId: 'o1', eventId: 'e1' });
  });
  it('nack quando payload invalido', () => {
    expect(decideMessage(JSON.stringify({ ...base, type: 'order.status_changed', orderId: 'o1' }), 'order.status_changed').ack).toBe(false);
  });
  it('nack quando routing key nao casa', () => {
    expect(decideMessage(validRaw, 'order.status_changed').ack).toBe(false);
  });
});

describe('handleEvent', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
  });
  it('order.created loga criado', () => {
    handleEvent({ ...base, type: 'order.created', orderId: 'o1', total: 30 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('criado'));
  });
  it('order.status_changed loga status', () => {
    handleEvent({ ...base, type: 'order.status_changed', orderId: 'o1', status: 'PAGO' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PAGO'));
  });
  it('sanitiza campo com controle', () => {
    handleEvent({ ...base, type: 'order.created', orderId: 'o1' + String.fromCharCode(10) + 'FAKE', total: 1 });
    const logged = log.mock.calls[0][0] as string;
    expect(logged).not.toContain(String.fromCharCode(10));
    expect(logged).toContain('o1?FAKE');
  });
});

describe('handleDelivery', () => {
  it('claim ok + handle ok -> ack processed + recordProcessed chamado', async () => {
    const claim = jest.fn().mockResolvedValue('tok');
    const release = jest.fn();
    const handle = jest.fn();
    const recordProcessed = jest.fn().mockResolvedValue(undefined);
    const a = await handleDelivery(validRaw, 'order.created', { claim, release, handle, recordProcessed });
    expect(a).toEqual({ type: 'ack', reason: 'processed' });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(recordProcessed).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('recordProcessed falho nao quebra o ack', async () => {
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockResolvedValue('tok'),
      release: jest.fn(),
      handle: jest.fn(),
      recordProcessed: jest.fn().mockRejectedValue(new Error('redis down')),
    });
    expect(a).toEqual({ type: 'ack', reason: 'processed' });
  });

  it('duplicata (claim null) -> ack duplicate, sem processar', async () => {
    const handle = jest.fn();
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockResolvedValue(null),
      release: jest.fn(),
      handle,
    });
    expect(a).toEqual({ type: 'ack', reason: 'duplicate' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('store indisponivel (claim lanca) -> requeue', async () => {
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockRejectedValue(new Error('redis down')),
      release: jest.fn(),
      handle: jest.fn(),
    });
    expect(a.type).toBe('nack-requeue');
  });

  it('handle falha + release OK -> requeue (reprocessa)', async () => {
    const release = jest.fn().mockResolvedValue(true);
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockResolvedValue('tok'),
      release,
      handle: jest.fn(() => {
        throw new Error('boom');
      }),
    });
    expect(a.type).toBe('nack-requeue');
    expect(release).toHaveBeenCalledWith('e1', 'tok');
  });

  it('handle falha + release FALHA (retorna false) -> DLQ (evita perda)', async () => {
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockResolvedValue('tok'),
      release: jest.fn().mockResolvedValue(false),
      handle: jest.fn(() => {
        throw new Error('boom');
      }),
    });
    expect(a.type).toBe('nack-dlq');
  });

  it('handle falha + release LANCA -> DLQ (evita perda)', async () => {
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockResolvedValue('tok'),
      release: jest.fn().mockRejectedValue(new Error('redis down')),
      handle: jest.fn(() => {
        throw new Error('boom');
      }),
    });
    expect(a.type).toBe('nack-dlq');
  });

  it('payload invalido -> nack-dlq (sem claim)', async () => {
    const claim = jest.fn();
    const a = await handleDelivery('{ invalido', 'order.created', { claim, release: jest.fn(), handle: jest.fn() });
    expect(a.type).toBe('nack-dlq');
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('executeAction', () => {
  const makeCh = () => ({ ack: jest.fn(), nack: jest.fn() });

  it('ack -> channel.ack, sem atraso', async () => {
    const ch = makeCh();
    const delay = jest.fn().mockResolvedValue(undefined);
    await executeAction(ch, 'MSG', { type: 'ack', reason: 'processed' }, delay);
    expect(ch.ack).toHaveBeenCalledWith('MSG');
    expect(ch.nack).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it('nack-dlq -> channel.nack(false,false), sem atraso', async () => {
    const ch = makeCh();
    const delay = jest.fn().mockResolvedValue(undefined);
    await executeAction(ch, 'MSG', { type: 'nack-dlq', reason: 'x' }, delay);
    expect(ch.nack).toHaveBeenCalledWith('MSG', false, false);
    expect(delay).not.toHaveBeenCalled();
  });

  it('nack-requeue -> atraso e channel.nack(false,true)', async () => {
    const ch = makeCh();
    const delay = jest.fn().mockResolvedValue(undefined);
    await executeAction(ch, 'MSG', { type: 'nack-requeue', reason: 'x' }, delay);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(ch.nack).toHaveBeenCalledWith('MSG', false, true);
  });
});

describe('sanitizeForLog', () => {
  it('troca controle por ?', () => {
    expect(sanitizeForLog('a' + String.fromCharCode(10) + 'b')).toBe('a?b');
  });
  it('trunca acima de 300', () => {
    const out = sanitizeForLog('x'.repeat(400));
    expect(out.length).toBeLessThanOrEqual(303);
    expect(out.endsWith('...')).toBe(true);
  });
});
