import amqp from 'amqplib';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Exige RABBITMQ_URL (sem fallback). Retenta para tolerar o broker subindo.
export async function connect() {
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    throw new Error('RABBITMQ_URL nao definida: copie .env.example para .env');
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      lastErr = err;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[connection] tentativa ' + attempt + '/' + MAX_RETRIES + ' falhou: ' + reason);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}
