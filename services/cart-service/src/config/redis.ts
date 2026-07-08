import Redis from 'ioredis';

// Cliente Redis unico, reutilizado em toda a aplicacao.
// A URL e resolvida em runtime (licao aprendida: nao capturar env no topo do modulo).
let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    redisClient = new Redis(url, {
      // Limita retentativas por comando: se o Redis cair, o comando falha rapido
      // em vez de travar a requisicao esperando reconexao indefinida.
      maxRetriesPerRequest: 2,
    });
    redisClient.on('error', (err) => {
      // NAO derruba o processo: ioredis reconecta sozinho, e cair num erro
      // transitorio seria pior. Diferente do product: aqui o Redis e a FONTE
      // DA VERDADE do carrinho, entao a saude dele e reportada no /health.
      console.warn('[redis] erro de conexao:', err.name);
    });
  }
  return redisClient;
}
