/*
  Warnings:

  - The `status` column on the `idempotency_records` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "idempotency_records" DROP COLUMN "status",
ADD COLUMN     "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING';

-- CreateIndex
CREATE INDEX "idempotency_records_status_idx" ON "idempotency_records"("status");

-- Dedup ATOMICO: no maximo UMA pendencia aberta por pedido.
CREATE UNIQUE INDEX "pending_compensations_open_key"
  ON "pending_compensations" ("orderId")
  WHERE "resolvedAt" IS NULL;
