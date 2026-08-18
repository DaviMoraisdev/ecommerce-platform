import type { AppConfig } from '../../src/config/env';

/** 48 caracteres: passa o minimo de 32 e nao esta na lista de placeholders. */
export const SEGREDO_DE_TESTE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

/**
 * Segredos DIFERENTES entre si, de proposito.
 *
 * Com o mesmo valor nos dois campos, uma troca entre webhookSecret e jwtSecret
 * dentro do loadConfig passaria por todos os testes. Valores distintos tornam a
 * troca visivel.
 */
export const SEGREDO_WEBHOOK = 'webhook0000111122223333444455556666777788889999aa';
export const SEGREDO_JWT = 'jwt0000aaaabbbbccccddddeeeeffff11112222333344445555';

/**
 * Fonte UNICA da forma do AppConfig nos testes.
 *
 * Antes cada arquivo montava o objeto completo, e toda variavel nova de ambiente
 * quebrava N fixtures — aconteceu tres vezes no Bloco 3. Com o builder, crescer
 * o AppConfig toca UM lugar.
 */
export function configDeTeste(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3007,
    databaseUrl: 'postgresql://u:p@127.0.0.1:5432/payment_db',
    defaultCurrency: 'BRL',
    nodeEnv: 'test',
    provider: 'fake',
    webhookSecret: SEGREDO_WEBHOOK,
    jwtSecret: SEGREDO_JWT,
    orderServiceUrl: 'http://localhost:3006',
    orderServiceTimeoutMs: 5000,
    paymentWindowMinutes: 15,
    ...overrides,
  };
}

/**
 * Fonte UNICA da forma do AMBIENTE nos testes.
 *
 * Irmao de configDeTeste: um monta o objeto AppConfig, o outro monta as
 * variaveis que o loadConfig le. Toda variavel obrigatoria nova quebrava as
 * fixtures de env.test.ts — aconteceu duas vezes no Bloco 3, com os segredos e
 * depois com ORDER_SERVICE_URL.
 */
export function envDeTeste(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PAYMENT_PORT: '3007',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/payment_db',
    DEFAULT_CURRENCY: 'BRL',
    NODE_ENV: 'test',
    PAYMENT_PROVIDER: 'fake',
    PAYMENT_WEBHOOK_SECRET: SEGREDO_WEBHOOK,
    JWT_SECRET: SEGREDO_JWT,
    ORDER_SERVICE_URL: 'http://localhost:3006',
    ...overrides,
  };
}
