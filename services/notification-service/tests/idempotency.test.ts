jest.mock('../src/config/redis');
import { getRedisClient } from '../src/config/redis';
import { claimEvent, releaseEvent, pingRedis } from '../src/idempotency';

const set = jest.fn();
const evalFn = jest.fn();
const ping = jest.fn();
(getRedisClient as jest.Mock).mockReturnValue({ set, eval: evalFn, ping });

describe('idempotency', () => {
  beforeEach(() => {
    set.mockReset();
    evalFn.mockReset();
    ping.mockReset();
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

  it('releaseEvent: claim de outro (0) -> false', async () => {
    evalFn.mockResolvedValue(0);
    expect(await releaseEvent('e1', 'tok-123')).toBe(false);
  });

  it('pingRedis: chama redis.ping (fail-fast no boot)', async () => {
    ping.mockResolvedValue('PONG');
    await expect(pingRedis()).resolves.toBeUndefined();
    expect(ping).toHaveBeenCalled();
  });

  it('pingRedis: propaga erro se o Redis nao responde', async () => {
    ping.mockRejectedValue(new Error('down'));
    await expect(pingRedis()).rejects.toThrow('down');
  });
});
