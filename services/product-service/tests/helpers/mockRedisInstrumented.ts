// Mock STATEFUL + INSTRUMENTADO do redis para os testes de cache (8c-3).
//
// Combina duas capacidades:
// - Stateful: get/set/incr compartilham um Map real. Ler uma chave depois de
//   incr/set reflete a escrita — como em producao. Liga a leitura da versao
//   (getCacheVersion) a escrita dela (invalidateListCache via incr).
// - Instrumentado: get/set/incr sao jest.fn, entao da para inspecionar chamadas
//   e sobrescrever com erro para testar degradacao.
//
// O set aceita argumentos variadicos (...rest) porque o codigo real chama
// set(key, value, 'EX', ttl) — 4 argumentos, nao 2.
//
// resetRedisMock() limpa o store E as chamadas — chamar no beforeEach.

const store = new Map<string, string>();

export const redisFns = {
  get: jest.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
  set: jest.fn(async (key: string, value: string, ..._rest: unknown[]) => {
    store.set(key, value);
    return 'OK';
  }),
  incr: jest.fn(async (key: string) => {
    const next = parseInt(store.get(key) ?? '0', 10) + 1;
    store.set(key, String(next));
    return next;
  }),
};

function installDefaults() {
  redisFns.get.mockImplementation(async (key: string) =>
    store.has(key) ? store.get(key)! : null
  );
  redisFns.set.mockImplementation(async (key: string, value: string, ..._rest: unknown[]) => {
    store.set(key, value);
    return 'OK';
  });
  redisFns.incr.mockImplementation(async (key: string) => {
    const next = parseInt(store.get(key) ?? '0', 10) + 1;
    store.set(key, String(next));
    return next;
  });
}

export function resetRedisMock() {
  store.clear();
  redisFns.get.mockReset();
  redisFns.set.mockReset();
  redisFns.incr.mockReset();
  installDefaults();
}

export function makeInstrumentedRedis() {
  return {
    getRedisClient: () => redisFns,
  };
}
