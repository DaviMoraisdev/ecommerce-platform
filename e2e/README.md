# Testes e2e (Fase 4, Bloco 9)

Suite ponta a ponta que roda contra o stack LOCAL de pe (nao mocka os servicos).
Cria dados reais e usa JWT -> por seguranca, so roda contra localhost por padrao
(alvo nao-local exige `E2E_ALLOW_DESTRUCTIVE=true`).

## Pre-requisitos
1. Infra: `docker compose up -d` (postgres, mongo, redis, rabbitmq).
2. Migrations Prisma aplicadas (o `/health` so checa conexao, NAO as tabelas):

       ( cd ../services/auth-service && npx prisma migrate deploy )
       ( cd ../services/inventory-service && npx prisma migrate deploy )
       ( cd ../services/order-service && npx prisma migrate deploy )

3. Servicos rodando (`npm run dev`): auth (3001), product (3003), inventory (3004),
   cart (3005), order (3006) e o notification-service (worker; consome os eventos).
4. `.env` deste pacote: `JWT_SECRET` igual ao dos servicos + as URLs + `REDIS_URL`.
   Ver `.env.example`.

## Rodar
    npm ci
    npm test

## Cobertura
- **Happy path:** cart -> order -> inventory (pedido, reserva, carrinho limpo).
- **Jornada com auth-service:** register + login reais -> compra com o accessToken emitido por ele.
- **Idempotencia:** sequencial e CONCORRENTE (mesma chave simultanea -> uma reserva).
- **Auth:** sem token / token invalido -> 401; nao-admin nao seta estoque -> 403; nao-admin compra -> 201.
- **Concorrencia:** N pedidos disputando o mesmo estoque -> sem oversell (causa dos 409 verificada).
- **Notification:** prova o caminho assincrono outbox -> relay -> broker -> consumer (marcador no Redis).

## Limpeza e limites
- Produtos criados sao removidos no `afterAll` (best-effort). Pedidos/estoque/usuarios NAO sao removidos (sem hard-delete no dominio); rode contra banco LOCAL/descartavel.

## Pagamentos (Fase 5, Bloco 8f)

`tests/payment.e2e.test.ts` exige, alem do stack acima:

5. payment-service rodando em 3007 (`npm run dev`), com `.env` de desenvolvimento:
   `PAYMENT_PROVIDER=fake`, `ORDER_SERVICE_URL=http://localhost:3006`, `RABBITMQ_URL`,
   `PAYMENT_EXPIRATION_ENABLED=true`, `PAYMENT_WINDOW_MINUTES=1` (minimo aceito),
   `RECONCILIACAO_POLL_INTERVAL_MS=5000`, `JOBS_VARREDURA_TIMEOUT_MS=1000` e
   `WEBHOOK_QUARANTINE_MINUTES` acima da folga que o boot calcula (janela + poll + ciclo;
   com os valores acima, 4 ou mais). Migrations aplicadas: `( cd ../services/payment-service && npx prisma migrate deploy )`.
6. order-service com `PAYMENTS_CONSUMER_ENABLED=true` (consome `payment.captured` e `payment.expired`).
7. `.env` deste pacote com `PAYMENT_URL` e `PAYMENT_WEBHOOK_SECRET` (o mesmo do payment).

Cobertura: pago ponta a ponta (outbox -> relay -> RabbitMQ -> pedido PAGO); expiracao +
compensacao (pedido CANCELADO, reserva liberada — o caso espera a janela real, ~1-2 min);
webhook com assinatura invalida (401); webhook autentico para cobranca desconhecida (503
retentavel). Duplicado, fora de ordem e valor divergente ficam na integracao do payment:
o e2e nao tem a referencia da cobranca e a rota nao distingue os desfechos pelo corpo.

## Futuro (TECH_DEBT, Fase 7)
Automatizar o boot do stack via docker-compose para rodar o e2e no CI.
