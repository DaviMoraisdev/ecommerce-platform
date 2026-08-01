import {
  parseEvent,
  decideMessage,
  handleEvent,
  sanitizeForLog,
  handleDelivery,
} from '../src/consumer';

const base = { eventId: 'e1' };
const validRaw = JSON.stringify({ ...base, type: 'order.created', orderId: 'o1', total: 10 });

describe('parseEvent', () => {
  it('aceita order.created valido (com total e eventId)', () => {
    const raw = JSON.stringify({ ...base, type: 'order.created', orderId: 'o1', userId: 'u1', total: 30 });
    expect(parseEvent(raw)).toMatchObject({ type: 'order.created', orderId: 'o1', total: 30, eventId: 'e1' });
  });

  it('aceita order.status_changed valido (com status)', () => {
    const raw = JSON.stringify({ ...base, type: 'order.status_changed', orderId: 'o1', status: 'PAGO' });
    expect(parseEvent(raw)).toMatchObject({ type: 'order.status_changed', orderId: 'o1', status: 'PAGO' });
  });

  it('rejeita JSON malformado', () => {
    expect(parseEvent('{ invalido')).toBeNull();
  });

  it('rejeita sem eventId (obrigatorio para dedup)', () => {
    expect(parseEvent(JSON.stringify({ type: 'order.created', orderId: 'o1', total: 1 }))).toBeNull();
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

  it('rejeita order.created sem total (obrigatorio por tipo)', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.created', orderId: 'o1' }))).toBeNull();
  });

  it('rejeita order.status_changed sem status (obrigatorio por tipo)', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.status_changed', orderId: 'o1' }))).toBeNull();
  });

  it('rejeita schema incorreto: total como string', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.created', orderId: 'o1', total: 'trinta' }))).toBeNull();
  });

  it('rejeita schema incorreto: orderId numero', () => {
    expect(parseEvent(JSON.stringify({ ...base, type: 'order.created', orderId: 123, total: 1 }))).toBeNull();
  });

  it('rejeita nao-objeto (array e numero)', () => {
    expect(parseEvent(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseEvent(JSON.stringify(42))).toBeNull();
  });
});

describe('decideMessage', () => {
  it('ack quando routing key casa com o type', () => {
    const d = decideMessage(validRaw, 'order.created');
    expect(d.ack).toBe(true);
    expect(d.event).toMatchObject({ orderId: 'o1', eventId: 'e1' });
  });

  it('nack quando o payload e invalido/incompleto', () => {
    const raw = JSON.stringify({ ...base, type: 'order.status_changed', orderId: 'o1' });
    expect(decideMessage(raw, 'order.status_changed').ack).toBe(false);
  });

  it('nack quando routing key nao casa com o type', () => {
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
    handleEvent({ ...base, type: 'order.created', orderId: 'o1', userId: 'u1', total: 30 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('criado'));
  });

  it('order.status_changed loga a mudanca de status', () => {
    handleEvent({ ...base, type: 'order.status_changed', orderId: 'o1', status: 'PAGO' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PAGO'));
  });

  it('sanitiza campo com caractere de controle', () => {
    handleEvent({ ...base, type: 'order.created', orderId: 'o1' + String.fromCharCode(10) + 'FAKE', total: 1 });
    const logged = log.mock.calls[0][0] as string;
    expect(logged).not.toContain(String.fromCharCode(10));
    expect(logged).toContain('o1?FAKE');
  });

  it('tipo desconhecido cai no default', () => {
    handleEvent({ ...base, type: 'order.explodiu', orderId: 'o1' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('nao tratado'));
  });
});

describe('handleDelivery', () => {
  it('valido + claim ok + handle ok -> ack processed', async () => {
    const claim = jest.fn().mockResolvedValue(true);
    const release = jest.fn();
    const handle = jest.fn();
    const a = await handleDelivery(validRaw, 'order.created', { claim, release, handle });
    expect(a).toEqual({ type: 'ack', reason: 'processed' });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('duplicata (claim false) -> ack duplicate, sem processar', async () => {
    const handle = jest.fn();
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockResolvedValue(false),
      release: jest.fn(),
      handle,
    });
    expect(a).toEqual({ type: 'ack', reason: 'duplicate' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('store indisponivel (claim lanca) -> requeue, sem processar', async () => {
    const handle = jest.fn();
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockRejectedValue(new Error('redis down')),
      release: jest.fn(),
      handle,
    });
    expect(a.type).toBe('nack-requeue');
    expect(handle).not.toHaveBeenCalled();
  });

  it('handle falha APOS o claim -> libera o claim e requeue', async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    const a = await handleDelivery(validRaw, 'order.created', {
      claim: jest.fn().mockResolvedValue(true),
      release,
      handle: jest.fn(() => {
        throw new Error('boom');
      }),
    });
    expect(a.type).toBe('nack-requeue');
    expect(release).toHaveBeenCalledWith('e1');
  });

  it('payload invalido -> nack-dlq (sem claim)', async () => {
    const claim = jest.fn();
    const a = await handleDelivery('{ invalido', 'order.created', { claim, release: jest.fn(), handle: jest.fn() });
    expect(a.type).toBe('nack-dlq');
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('sanitizeForLog', () => {
  it('troca caracteres de controle por ?', () => {
    const input = 'a' + String.fromCharCode(10) + 'b' + String.fromCharCode(9) + 'c';
    expect(sanitizeForLog(input)).toBe('a?b?c');
  });

  it('trunca acima de 300 chars', () => {
    const out = sanitizeForLog('x'.repeat(400));
    expect(out.length).toBeLessThanOrEqual(303);
    expect(out.endsWith('...')).toBe(true);
  });
});
