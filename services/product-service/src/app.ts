import express, { Request, Response } from 'express';
import helmet from 'helmet';
import productRoutes from './routes/product.routes';

// Cria e configura o app Express SEM efeitos colaterais:
// nao valida env, nao conecta banco, nao chama listen.
// Isso o torna importavel em testes (Supertest) sem subir servidor
// nem tocar o banco de producao.
const app = express();

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

export default app;
