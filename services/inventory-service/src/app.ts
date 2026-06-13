import express, { Request, Response } from 'express';
import helmet from 'helmet';

const app = express();

app.use(helmet());
app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'inventory-service',
    timestamp: new Date().toISOString(),
  });
});

export default app;
