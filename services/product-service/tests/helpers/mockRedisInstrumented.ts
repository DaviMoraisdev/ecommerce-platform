// Mock INSTRUMENTADO do redis para os testes de cache (8c-3), onde o Redis
// e o alvo do teste — nao apenas ruido a silenciar.
//
// Diferente do mockRedis.ts (fake funcional em memoria), este expoe os jest.fn
// de get/set/incr para que cada teste configure o retorno (mockResolvedValue,
// mockRejectedValue) e inspecione as chamadas (toHaveBeenCalledWith).
//
// Uso no arquivo de teste:
//   jest.mock('../src/config/redis', () =>
//     require('./helpers/mockRedisInstrumented').makeInstrumentedRedis()
//   );
//   import { redisFns } from './helpers/mockRedisInstrumented';
//   redisFns.get.mockResolvedValue(null); // configura
//   expect(redisFns.set).toHaveBeenCalledWith(...); // inspeciona

export const redisFns = {
  get: jest.fn(),
  set: jest.fn(),
  incr: jest.fn(),
};

export function makeInstrumentedRedis() {
  return {
    getRedisClient: () => redisFns,
  };
}
