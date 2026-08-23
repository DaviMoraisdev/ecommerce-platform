/*
  Warnings:

  - Added the required column `amountCents` to the `inbox_events` table without a default value. This is not possible if the table is not empty.
  - Added the required column `currency` to the `inbox_events` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orderId` to the `inbox_events` table without a default value. This is not possible if the table is not empty.
  - Added the required column `paymentId` to the `inbox_events` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "inbox_events" ADD COLUMN     "amountCents" INTEGER NOT NULL,
ADD COLUMN     "currency" TEXT NOT NULL,
ADD COLUMN     "orderId" TEXT NOT NULL,
ADD COLUMN     "paymentId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "inbox_events_orderId_idx" ON "inbox_events"("orderId");
