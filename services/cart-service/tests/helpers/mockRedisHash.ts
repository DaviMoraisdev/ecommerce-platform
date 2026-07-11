// Mock stateful do ioredis para Hashes: liga escrita e leitura via um Map,
// provando o comportamento real (ex.: HINCRBY refletido no HGETALL).
export function createMockRedis() {
  const store = new Map<string, Map<string, string>>();

  const client = {
    async hgetall(key: string): Promise<Record<string, string>> {
      const h = store.get(key);
      return h ? Object.fromEntries(h) : {};
    },
    async hincrby(key: string, field: string, incr: number): Promise<number> {
      let h = store.get(key);
      if (!h) {
        h = new Map();
        store.set(key, h);
      }
      const next = Number(h.get(field) ?? 0) + incr;
      h.set(field, String(next));
      return next;
    },
    async hset(key: string, field: string, value: string | number): Promise<number> {
      let h = store.get(key);
      if (!h) {
        h = new Map();
        store.set(key, h);
      }
      const existed = h.has(field);
      h.set(field, String(value));
      return existed ? 0 : 1;
    },
    async hexists(key: string, field: string): Promise<number> {
      const h = store.get(key);
      return h && h.has(field) ? 1 : 0;
    },
    async hdel(key: string, field: string): Promise<number> {
      const h = store.get(key);
      if (!h) return 0;
      const had = h.delete(field);
      if (h.size === 0) store.delete(key);
      return had ? 1 : 0;
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
    async expire(key: string, _ttl: number): Promise<number> {
      return store.has(key) ? 1 : 0;
    },
  };

  return { client, store };
}
