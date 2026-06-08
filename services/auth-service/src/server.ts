import express, { Request, Response } from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import { globalLimiter } from './middlewares/rateLimit.middleware';

dotenv.config();

const app = express();
const PORT = process.env.AUTH_PORT || 3001;

// Confia no primeiro proxy (Nginx) para ler o IP real do cliente via X-Forwarded-For
app.set('trust proxy', 1);

app.use(helmet());

// Health check ANTES do rate limiter — monitoramento nunca deve receber 429
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'auth-service',
    timestamp: new Date().toISOString(),
  });
});

// Limiter global antes do parser de body, protegendo contra volume
app.use(globalLimiter);
app.use(express.json());

app.use('/auth', authRoutes);

app.listen(PORT, () => {
  console.log(`Auth service rodando na porta ${PORT}`);
});

export default app;
