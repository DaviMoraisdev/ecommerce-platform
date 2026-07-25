-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_records_status_idx" ON "idempotency_records"("status");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_userId_key_key" ON "idempotency_records"("userId", "key");
