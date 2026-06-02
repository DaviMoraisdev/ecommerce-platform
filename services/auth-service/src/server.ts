import express, { Request, Response } from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';

dotenv.config();

const app = express();
const PORT = process.env.AUTH_PORT || 3001;

app.use(helmet());
app.use(express.json());

app.use('/auth', authRoutes);

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'auth-service',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Auth service rodando na porta ${PORT}`);
});

export default app;
