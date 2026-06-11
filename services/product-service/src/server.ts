import express, { Request, Response } from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { connectDatabase } from './config/database';
import productRoutes from './routes/product.routes';

dotenv.config();

const app = express();
const PORT = process.env.PRODUCT_PORT || 3003;

app.use(helmet());
app.use(express.json());

app.use('/products', productRoutes);

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'product-service',
    timestamp: new Date().toISOString(),
  });
});

async function startServer() {
  await connectDatabase();
  app.listen(PORT, () => {
    console.log(`Product service rodando na porta ${PORT}`);
  });
}

startServer();

export default app;
