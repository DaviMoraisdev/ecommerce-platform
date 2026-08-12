# order-service

Servico de pedidos (Fase 4). PostgreSQL via Prisma.

## Rodar (dev)
1. Na raiz: `docker compose up -d postgres`
2. `cp .env.example .env` e ajuste as credenciais.
3. `npm install && npx prisma migrate deploy`
4. `npm run dev`

## Testes
- `npm test` — testes unitarios (nao tocam o banco; seguros em qualquer ambiente).
- `npm run test:integration` — integracao contra um banco ISOLADO. Pre-requisitos:
  1. `cp .env.test.example .env.test` (mantenha ALLOW_TEST_DB_RESET=true).
  2. Criar o banco: `docker exec ecommerce-postgres psql -U postgres -c "CREATE DATABASE order_test_db;"`
  3. Aplicar migrations no banco de teste:
     `( set -a; . ./.env.test; set +a; npx prisma migrate deploy )`
  4. `npm run test:integration`

O teste de integracao tem um guard quadruplo (nome EXATO do banco lido do pathname da
URL + NODE_ENV=test + ALLOW_TEST_DB_RESET=true + host local, salvo
ALLOW_REMOTE_TEST_DB=true) que aborta antes de qualquer escrita destrutiva se apontado
para qualquer banco que nao seja o de teste. Ver tests/helpers/testDbGuard.ts.
