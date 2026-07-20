/*
  Warnings:

  - A unique constraint covering the columns `[seq]` on the table `order_status_history` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "order_status_history" ADD COLUMN     "seq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "order_status_history_seq_key" ON "order_status_history"("seq");
