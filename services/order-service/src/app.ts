import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { prisma } from './config/database';

const app = express();
app.use(helmet());
app.use(express.json());

// Health ativo: um SELECT 1 prova que o banco responde.
app.get('/health', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: 'ok',
      service: 'order-service',
      database: 'up',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      service: 'order-service',
      database: 'down',
      timestamp: new Date().toISOString(),
    });
  }
});

export default app;
