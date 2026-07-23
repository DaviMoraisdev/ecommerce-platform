-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservations_orderId_idx" ON "reservations"("orderId");

-- CreateIndex
CREATE INDEX "reservations_productId_idx" ON "reservations"("productId");

-- Reserva sempre de quantidade positiva.
ALTER TABLE "reservations" ADD CONSTRAINT "reserva_quantity_positiva" CHECK ("quantity" > 0);
