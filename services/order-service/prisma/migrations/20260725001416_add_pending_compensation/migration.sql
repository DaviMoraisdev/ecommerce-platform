-- CreateTable
CREATE TABLE "pending_compensations" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "pending_compensations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_compensations_resolvedAt_idx" ON "pending_compensations"("resolvedAt");
