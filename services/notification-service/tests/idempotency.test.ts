jest.mock('../src/config/redis');
import { getRedisClient } from '../src/config/redis';
import { claimEvent, releaseEvent } from '../src/idempotency';

const set = jest.fn();
const evalFn = jest.fn();
(getRedisClient as jest.Mock).mockReturnValue({ set, eval: evalFn });

describe('idempotency', () => {
  beforeEach(() => {
    set.mockReset();
    evalFn.mockReset();
  });

  it('claimEvent: SET chave <token> PX ttl NX; OK -> retorna token', async () => {
    set.mockResolvedValue('OK');
    const token = await claimEvent('e1');
    expect(typeof token).toBe('string');
    expect(token).not.toBe('');
    const args = set.mock.calls[0];
    expect(args[0]).toBe('notif:evt:e1');
    expect(args[1]).toBe(token);
    expect(args[2]).toBe('PX');
    expect(typeof args[3]).toBe('number');
    expect(args[4]).toBe('NX');
  });

  it('claimEvent: null -> retorna null (duplicata)', async () => {
    set.mockResolvedValue(null);
    expect(await claimEvent('e1')).toBeNull();
  });

  it('releaseEvent: compare-and-delete via Lua; removeu (1) -> true', async () => {
    evalFn.mockResolvedValue(1);
    const ok = await releaseEvent('e1', 'tok-123');
    expect(ok).toBe(true);
    const args = evalFn.mock.calls[0];
    expect(args[1]).toBe(1);
    expect(args[2]).toBe('notif:evt:e1');
    expect(args[3]).toBe('tok-123');
  });

  it('releaseEvent: claim de outro (0) -> false (nao apaga o que nao e nosso)', async () => {
    evalFn.mockResolvedValue(0);
    expect(await releaseEvent('e1', 'tok-123')).toBe(false);
  });
});
