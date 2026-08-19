import type { Express } from 'express';

import { getPrisma } from './config/database';
import type { AppConfig } from './config/env';
import { createApp } from './app';
import { OrderClient } from './clients/order.client';
import { criarPaymentController } from './controllers/payment.controller';
import { criarAuthMiddleware } from './middlewares/auth.middleware';
import { criarPaymentProvider } from './providers/factory';
import { criarPaymentRouter } from './routes/payment.routes';
import { criarWebhookRouter } from './routes/webhook.routes';
import { PaymentService } from './services/payment.service';
import { WebhookService } from './services/webhook.service';

/**
 * Composition root: o unico lugar que conhece todas as pecas e as liga.
 *
 * Roda DEPOIS do connectDatabase — o bootstrap garante a ordem —, entao o
 * getPrisma() aqui encontra o cliente ja conectado. Se a ordem fosse invertida,
 * ele lancaria com mensagem explicita em vez de falhar na primeira consulta.
 */
export function construirApp(config: AppConfig): Express {
  const prisma = getPrisma();
  const provider = criarPaymentProvider(config);

  const orderClient = new OrderClient({
    baseUrl: config.orderServiceUrl,
    timeoutMs: config.orderServiceTimeoutMs,
  });

  const service = new PaymentService({
    prisma,
    orderClient,
    provider,
    currency: config.defaultCurrency,
    windowMinutes: config.paymentWindowMinutes,
  });

  const router = criarPaymentRouter({
    authMiddleware: criarAuthMiddleware(config.jwtSecret),
    controller: criarPaymentController(service),
  });

  // O provider e o MESMO objeto usado para criar cobranca: verifyWebhook
  // valida com o segredo que veio do config, sem segunda fonte de verdade.
  return createApp({
    payments: router,
    webhooks: criarWebhookRouter({
      provider,
      service: new WebhookService({ prisma }),
    }),
  });
}
