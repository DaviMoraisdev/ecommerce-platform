import { getRedisClient } from './config/redis';

// Janela de dedup: quanto tempo um eventId fica reivindicado. Deve cobrir com
// folga o pior caso de reentrega. Default 48h; ajustavel por env.
const TTL_MS = (() => {
  const n = Number(process.env.IDEMPOTENCY_TTL_MS);
  return Number.isInteger(n) && n > 0 ? n : 48 * 60 * 60 * 1000;
})();
const PREFIX = 'notif:evt:';

// Claim atomico: SET key 1 PX ttl NX. Retorna true se ESTE consumo reivindicou o
// eventId pela primeira vez; false se ja estava reivindicado (duplicata) — nesse
// caso o chamador deve dar ack e ignorar, sem reprocessar.
export async function claimEvent(eventId: string): Promise<boolean> {
  const redis = getRedisClient();
  const res = await redis.set(PREFIX + eventId, '1', 'PX', TTL_MS, 'NX');
  return res === 'OK';
}
