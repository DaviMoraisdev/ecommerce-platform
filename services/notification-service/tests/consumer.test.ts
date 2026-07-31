import { parseEvent, decideMessage, handleEvent, sanitizeForLog } from '../src/consumer';

const base = { eventId: 'e1' };

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

  it('rejeita nao-objeto (array e numero)', () => {
    expect(parseEvent(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseEvent(JSON.stringify(42))).toBeNull();
  });
});

describe('decideMessage', () => {
  it('ack quando routing key casa com o type', () => {
    const raw = JSON.stringify({ ...base, type: 'order.created', orderId: 'o1', total: 30 });
    const d = decideMessage(raw, 'order.created');
    expect(d.ack).toBe(true);
    expect(d.event).toMatchObject({ orderId: 'o1', eventId: 'e1' });
  });

  it('nack quando o payload e invalido/incompleto', () => {
    const raw = JSON.stringify({ ...base, type: 'order.status_changed', orderId: 'o1' });
    const d = decideMessage(raw, 'order.status_changed');
    expect(d.ack).toBe(false);
    expect(d.event).toBeNull();
  });

  it('nack quando routing key nao casa com o type', () => {
    const raw = JSON.stringify({ ...base, type: 'order.created', orderId: 'o1', total: 30 });
    const d = decideMessage(raw, 'order.status_changed');
    expect(d.ack).toBe(false);
    expect(d.event).toBeNull();
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

  it('sanitiza campo com caractere de controle (anti log-injection)', () => {
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
