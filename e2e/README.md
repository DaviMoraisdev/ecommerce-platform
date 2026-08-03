# Testes e2e (Fase 4, Bloco 9)

Suite ponta a ponta que roda contra o stack LOCAL de pe (nao mocka os servicos).

## Pre-requisitos
1. Infra: `docker compose up -d` (postgres, mongo, redis, rabbitmq).
2. Servicos rodando (cada um `npm run dev` no seu terminal):
   product-service (3003), inventory-service (3004), cart-service (3005), order-service (3006).
3. `.env` deste pacote com `JWT_SECRET` igual ao dos servicos (copie de
   services/order-service/.env) + as URLs. Ver `.env.example`.

## Rodar
    npm install
    npm test

## Cobertura
- **Happy path:** produto+estoque -> carrinho -> pedido -> reserva + carrinho limpo; idempotencia por Idempotency-Key.
- **Concorrencia:** N pedidos concorrentes disputando o mesmo estoque -> exatamente o disponivel e vendido, sem oversell (reserva atomica do 7a).

## Futuro (TECH_DEBT, Fase 7)
Automatizar o boot do stack via docker-compose para rodar o e2e no CI (hoje o stack sobe manualmente).
