import { parseEvent, handleEvent, sanitizeForLog } from '../src/consumer';

describe('parseEvent', () => {
  it('aceita evento valido completo', () => {
    const raw = JSON.stringify({
      type: 'order.created', orderId: 'o1', userId: 'u1',
      status: 'PENDENTE', total: 30, at: '2026-01-01T00:00:00Z',
    });
    expect(parseEvent(raw)).toMatchObject({ type: 'order.created', orderId: 'o1', total: 30 });
  });

  it('aceita evento com so os obrigatorios', () => {
    const raw = JSON.stringify({ type: 'order.created', orderId: 'o1' });
    expect(parseEvent(raw)).toMatchObject({ type: 'order.created', orderId: 'o1' });
  });

  it('rejeita JSON malformado', () => {
    expect(parseEvent('{ invalido')).toBeNull();
  });

  it('rejeita sem type', () => {
    expect(parseEvent(JSON.stringify({ orderId: 'o1' }))).toBeNull();
  });

  it('rejeita sem orderId', () => {
    expect(parseEvent(JSON.stringify({ type: 'order.created' }))).toBeNull();
  });

  it('rejeita schema incorreto: total como string', () => {
    expect(parseEvent(JSON.stringify({ type: 'order.created', orderId: 'o1', total: 'trinta' }))).toBeNull();
  });

  it('rejeita schema incorreto: orderId numero', () => {
    expect(parseEvent(JSON.stringify({ type: 'order.created', orderId: 123 }))).toBeNull();
  });

  it('rejeita nao-objeto (array e numero)', () => {
    expect(parseEvent(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseEvent(JSON.stringify(42))).toBeNull();
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
    handleEvent({ type: 'order.created', orderId: 'o1', userId: 'u1', total: 30 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('criado'));
  });

  it('order.status_changed loga a mudanca de status', () => {
    handleEvent({ type: 'order.status_changed', orderId: 'o1', status: 'PAGO' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PAGO'));
  });

  it('tipo desconhecido cai no default', () => {
    handleEvent({ type: 'order.explodiu', orderId: 'o1' });
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
