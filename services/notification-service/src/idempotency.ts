import { getRedisClient } from './config/redis';
import { randomUUID } from 'node:crypto';

const PREFIX = 'notif:evt:';
const TTL_MIN_MS = 60 * 1000;
const TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_DEFAULT_MS = 48 * 60 * 60 * 1000;

function resolveTtlMs(): number {
  const n = Number(process.env.IDEMPOTENCY_TTL_MS);
  return Number.isInteger(n) && n >= TTL_MIN_MS && n <= TTL_MAX_MS ? n : TTL_DEFAULT_MS;
}

function key(eventId: string): string {
  return PREFIX + eventId;
}

// Compare-and-delete atomico: so apaga se o valor for o token DESTE consumo
// (evita apagar um claim readquirido por outra instancia apos expirar o TTL).
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// Claim atomico: SET key <token> PX ttl NX. Retorna o TOKEN se ESTE consumo
// reivindicou o eventId primeiro; null se ja estava reivindicado (duplicata).
export async function claimEvent(eventId: string): Promise<string | null> {
  const redis = getRedisClient();
  const token = randomUUID();
  const res = await redis.set(key(eventId), token, 'PX', resolveTtlMs(), 'NX');
  return res === 'OK' ? token : null;
}

// Libera SOMENTE se o claim ainda for deste consumo. Retorna true se removeu.
export async function releaseEvent(eventId: string, token: string): Promise<boolean> {
  const redis = getRedisClient();
  const res = await redis.eval(RELEASE_LUA, 1, key(eventId), token);
  return res === 1;
}

// Valida a conexao com o Redis (fail-fast no boot).
// Marcador de "processado" por pedido (observabilidade + gancho de e2e). Best-effort.
export async function recordProcessed(orderId: string, type: string): Promise<void> {
  const redis = getRedisClient();
  await redis.set('notif:proc:' + orderId + ':' + type, '1', 'PX', resolveTtlMs());
}

export async function pingRedis(): Promise<void> {
  await getRedisClient().ping();
}
