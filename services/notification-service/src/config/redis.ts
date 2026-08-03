import Redis from 'ioredis';

// Cliente Redis unico do consumer (usado so para idempotencia por eventId).
// URL resolvida em runtime (nao capturar env no topo do modulo).
let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL nao definida: copie .env.example para .env');
    }
    redisClient = new Redis(url, {
      // Falha rapido se o Redis cair, em vez de travar esperando reconexao.
      maxRetriesPerRequest: 2,
      // Limita o comando no CLIENTE (nao so no withTimeout externo): um comando
      // que nao responde e rejeitado em 2s, evitando acumulo apos o timeout.
      commandTimeout: 2000,
    });
    redisClient.on('error', (err) => {
      // Nao derruba o processo: ioredis reconecta sozinho.
      console.warn('[redis] erro de conexao:', err.name);
    });
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      /* ja fechado */
    }
    redisClient = null;
  }
}
