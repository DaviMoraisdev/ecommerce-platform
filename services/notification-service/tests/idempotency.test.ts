jest.mock('../src/config/redis');
import { getRedisClient } from '../src/config/redis';
import { claimEvent } from '../src/idempotency';

const set = jest.fn();
(getRedisClient as jest.Mock).mockReturnValue({ set });

describe('claimEvent (dedup por eventId)', () => {
  beforeEach(() => set.mockReset());

  it('primeira vez: SET NX retorna OK -> true', async () => {
    set.mockResolvedValue('OK');
    const ok = await claimEvent('e1');
    expect(ok).toBe(true);
    const args = set.mock.calls[0];
    expect(args[0]).toContain('e1');
    expect(args).toContain('NX');
    expect(args).toContain('PX');
  });

  it('duplicata: SET NX retorna null -> false', async () => {
    set.mockResolvedValue(null);
    expect(await claimEvent('e1')).toBe(false);
  });

  it('chaves diferentes para eventIds diferentes', async () => {
    set.mockResolvedValue('OK');
    await claimEvent('a');
    await claimEvent('b');
    expect(set.mock.calls[0][0]).not.toBe(set.mock.calls[1][0]);
  });
});
