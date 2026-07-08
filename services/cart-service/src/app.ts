import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { getRedisClient } from './config/redis';

// Cria e configura o app Express SEM efeitos colaterais:
// nao valida env, nao conecta nada, nao chama listen.
// Isso o torna importavel em testes (Supertest) sem subir servidor.
const app = express();
app.use(helmet());
app.use(express.json());

// Health check ATIVO: pinga o Redis. No cart-service o Redis e a fonte da
// verdade, entao "saudavel" significa "consigo falar com o Redis".
app.get('/health', async (req: Request, res: Response) => {
  try {
    const pong = await getRedisClient().ping();
    if (pong !== 'PONG') {
      throw new Error('resposta inesperada do Redis: ' + pong);
    }
    res.status(200).json({
      status: 'ok',
      service: 'cart-service',
      redis: 'up',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      service: 'cart-service',
      redis: 'down',
      timestamp: new Date().toISOString(),
    });
  }
});

export default app;
