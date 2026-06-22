import Redis from 'ioredis';

// Cliente Redis unico, reutilizado em toda a aplicacao.
// A URL e resolvida em runtime (lacao aprendida: nao capturar env no topo do modulo).
let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    redisClient = new Redis(url, {
      // Se o Redis cair, nao queremos travar o servico esperando reconexao.
      // maxRetriesPerRequest null + lazyConnect dao controle sobre falhas.
      maxRetriesPerRequest: 2,
    });

    redisClient.on('error', (err) => {
      // Log sem derrubar a aplicacao: cache e otimizacao, nao pode ser ponto de falha
      console.warn('[redis] erro de conexao:', err.name);
    });
  }
  return redisClient;
}
