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

## Futuro (TECH_DEBT, Fase 7)
Automatizar o boot do stack via docker-compose para rodar o e2e no CI.
