-- CreateTable
CREATE TABLE "inbox_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "routingKey" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbox_events_eventId_key" ON "inbox_events"("eventId");

-- CreateIndex
CREATE INDEX "inbox_events_processedAt_idx" ON "inbox_events"("processedAt");
