import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  // ATENCAO (Bloco 4): o parser JSON global NAO pode alcancar a rota de webhook —
  // a verificacao de assinatura HMAC exige o corpo cru. Quando a rota entrar,
  // ela sera montada ANTES deste middleware, com express.raw().
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'payment-service' });
  });

  return app;
}
