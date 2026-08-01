import { getRedisClient } from './config/redis';

const PREFIX = 'notif:evt:';
const TTL_MIN_MS = 60 * 1000; // 1 min
const TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const TTL_DEFAULT_MS = 48 * 60 * 60 * 1000; // 48h

// Resolvido em RUNTIME (nao no import) e validado entre min/max: a garantia e de
// deduplicacao TEMPORAL (janela do TTL), nao "efeito unico" para sempre.
function resolveTtlMs(): number {
  const n = Number(process.env.IDEMPOTENCY_TTL_MS);
  return Number.isInteger(n) && n >= TTL_MIN_MS && n <= TTL_MAX_MS ? n : TTL_DEFAULT_MS;
}

function key(eventId: string): string {
  return PREFIX + eventId;
}

// Claim atomico: SET key 1 PX ttl NX. true se ESTE consumo reivindicou primeiro;
// false se ja estava reivindicado (duplicata dentro da janela do TTL).
export async function claimEvent(eventId: string): Promise<boolean> {
  const redis = getRedisClient();
  const res = await redis.set(key(eventId), '1', 'PX', resolveTtlMs(), 'NX');
  return res === 'OK';
}

// Libera o claim (usado quando o processamento falha APOS o claim, para a
// reentrega reprocessar em vez de ser tratada como duplicata).
export async function releaseEvent(eventId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(key(eventId));
}
