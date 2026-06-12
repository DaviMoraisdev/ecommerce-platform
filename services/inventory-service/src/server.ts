import express, { Request, Response } from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { connectDatabase } from './config/database';

dotenv.config();

const REQUIRED_ENV = ['DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Variavel de ambiente obrigatoria ausente: ${key}`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.INVENTORY_PORT || 3004;

app.use(helmet());
app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'inventory-service',
    timestamp: new Date().toISOString(),
  });
});

async function startServer() {
  await connectDatabase();
  app.listen(PORT, () => {
    console.log(`Inventory service rodando na porta ${PORT}`);
  });
}

startServer();

export default app;
