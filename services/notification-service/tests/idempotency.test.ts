jest.mock('../src/config/redis');
import { getRedisClient } from '../src/config/redis';
import { claimEvent, releaseEvent } from '../src/idempotency';

const set = jest.fn();
const del = jest.fn();
(getRedisClient as jest.Mock).mockReturnValue({ set, del });

describe('idempotency', () => {
  beforeEach(() => {
    set.mockReset();
    del.mockReset();
  });

  it('claimEvent: SET chave 1 PX <ttl> NX; OK -> true', async () => {
    set.mockResolvedValue('OK');
    expect(await claimEvent('e1')).toBe(true);
    const args = set.mock.calls[0];
    expect(args[0]).toBe('notif:evt:e1');
    expect(args[1]).toBe('1');
    expect(args[2]).toBe('PX');
    expect(typeof args[3]).toBe('number');
    expect(args[3]).toBeGreaterThan(0);
    expect(args[4]).toBe('NX');
  });

  it('claimEvent: null -> false (duplicata)', async () => {
    set.mockResolvedValue(null);
    expect(await claimEvent('e1')).toBe(false);
  });

  it('releaseEvent: DEL na chave do eventId', async () => {
    del.mockResolvedValue(1);
    await releaseEvent('e1');
    expect(del).toHaveBeenCalledWith('notif:evt:e1');
  });
});
