import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import orderRoutes from './routes/order.routes';
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

app.use('/orders', orderRoutes);

// Error handler central: 500 JSON generico, sem vazar detalhe interno.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[order] erro inesperado:', err instanceof Error ? err.message : err);
  res.status(500).json({ error: 'Erro interno' });
});

export default app;
