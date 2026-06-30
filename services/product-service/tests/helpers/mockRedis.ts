// Mock compartilhado do redis para os testes do product-service.
// Um fake em memoria que responde aos comandos usados pelo service
// (get/set/incr) sem abrir conexao TCP — evita ruido de conexao e
// torna o comportamento do cache deterministico nos testes.
//
// Uso no arquivo de teste (require dentro da factory evita o hoisting do
// jest.mock, que e icado para antes dos imports):
//
//   jest.mock('../src/config/redis', () =>
//     require('./helpers/mockRedis').makeRedisMock()
//   );
export function makeRedisMock() {
  const store: Record<string, string> = {};
  const fakeClient = {
    get: jest.fn(async (key: string) => store[key] ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store[key] = value;
      return 'OK';
    }),
    incr: jest.fn(async (key: string) => {
      const next = parseInt(store[key] ?? '0', 10) + 1;
      store[key] = String(next);
      return next;
    }),
  };
  return { getRedisClient: () => fakeClient };
}
