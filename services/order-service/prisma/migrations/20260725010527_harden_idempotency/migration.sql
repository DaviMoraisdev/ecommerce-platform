-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable: CONVERTE a coluna preservando os valores (nao dropa/recria).
-- Todos os valores atuais ('PROCESSING'/'COMPLETED'/'FAILED') sao rotulos validos do enum.
ALTER TABLE "idempotency_records" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "idempotency_records"
  ALTER COLUMN "status" TYPE "IdempotencyStatus" USING "status"::"IdempotencyStatus";
ALTER TABLE "idempotency_records" ALTER COLUMN "status" SET DEFAULT 'PROCESSING';

-- Consolida pendencias abertas duplicadas ANTES do indice unico (mantem a mais
-- recente por pedido) — evita que o CREATE UNIQUE INDEX falhe em dados legados.
DELETE FROM "pending_compensations" a
USING "pending_compensations" b
WHERE a."resolvedAt" IS NULL
  AND b."resolvedAt" IS NULL
  AND a."orderId" = b."orderId"
  AND (a."createdAt" < b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

-- Dedup ATOMICO: no maximo UMA pendencia aberta por pedido.
CREATE UNIQUE INDEX "pending_compensations_open_key"
  ON "pending_compensations" ("orderId")
  WHERE "resolvedAt" IS NULL;
