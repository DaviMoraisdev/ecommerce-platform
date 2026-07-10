import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { getRedisClient } from './config/redis';
import cartRoutes from './routes/cart.routes';

const app = express();
app.use(helmet());
app.use(express.json());

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

app.use('/cart', cartRoutes);

export default app;
