-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED_UNSUPPORTED', 'DUPLICATE_ORDER', 'FAILED');

-- CreateEnum
CREATE TYPE "AttributionResult" AS ENUM ('ATTRIBUTED', 'UNATTRIBUTED');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('META', 'GOOGLE', 'TIKTOK', 'UTMIFY', 'REDTRACK');

-- CreateEnum
CREATE TYPE "ConversionStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED_PERMANENT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DeliveryAttemptStatus" AS ENUM ('SUCCESS', 'TRANSIENT_FAILURE', 'PERMANENT_FAILURE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "TrackingSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "customFields" JSONB,
    "fbclid" TEXT,
    "fbc" TEXT,
    "fbp" TEXT,
    "gclid" TEXT,
    "gbraid" TEXT,
    "wbraid" TEXT,
    "ttclid" TEXT,
    "ttp" TEXT,
    "redtrackClickId" TEXT,
    "utmifyId" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingSessionRevision" (
    "id" TEXT NOT NULL,
    "sessionRefId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "incomingPayload" JSONB NOT NULL,
    "appliedChanges" JSONB NOT NULL,
    "conflicts" JSONB NOT NULL,

    CONSTRAINT "TrackingSessionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "statusReason" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "webhookEventId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "customerEmail" TEXT,
    "webhookSessionId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributionSnapshot" (
    "id" TEXT NOT NULL,
    "orderRefId" TEXT NOT NULL,
    "result" "AttributionResult" NOT NULL,
    "level" INTEGER,
    "method" TEXT,
    "sessionRefId" TEXT,
    "customFields" JSONB,
    "customFieldsSource" TEXT NOT NULL,
    "identifiers" JSONB NOT NULL,
    "affiliateCode" TEXT,
    "affiliateCodeSource" TEXT,
    "affiliateEvidenceLevel" INTEGER,
    "alerts" JSONB NOT NULL,
    "unattributedReason" TEXT,
    "decisionTrace" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversion" (
    "id" TEXT NOT NULL,
    "orderRefId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "status" "ConversionStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "dedupKey" TEXT NOT NULL,
    "lastPayload" JSONB,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "conversionRefId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "DeliveryAttemptStatus" NOT NULL,
    "httpStatus" INTEGER,
    "requestPayload" JSONB NOT NULL,
    "responseBody" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReprocessRequest" (
    "id" TEXT NOT NULL,
    "orderRefId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "includePermanentFailures" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ReprocessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackingSession_sessionId_key" ON "TrackingSession"("sessionId");

-- CreateIndex
CREATE INDEX "TrackingSession_fbclid_idx" ON "TrackingSession"("fbclid");

-- CreateIndex
CREATE INDEX "TrackingSession_fbc_idx" ON "TrackingSession"("fbc");

-- CreateIndex
CREATE INDEX "TrackingSession_gclid_idx" ON "TrackingSession"("gclid");

-- CreateIndex
CREATE INDEX "TrackingSession_gbraid_idx" ON "TrackingSession"("gbraid");

-- CreateIndex
CREATE INDEX "TrackingSession_wbraid_idx" ON "TrackingSession"("wbraid");

-- CreateIndex
CREATE INDEX "TrackingSession_ttclid_idx" ON "TrackingSession"("ttclid");

-- CreateIndex
CREATE INDEX "TrackingSession_redtrackClickId_idx" ON "TrackingSession"("redtrackClickId");

-- CreateIndex
CREATE INDEX "TrackingSession_utmifyId_idx" ON "TrackingSession"("utmifyId");

-- CreateIndex
CREATE INDEX "TrackingSession_customerEmail_firstSeenAt_idx" ON "TrackingSession"("customerEmail", "firstSeenAt");

-- CreateIndex
CREATE INDEX "TrackingSessionRevision_sessionRefId_receivedAt_idx" ON "TrackingSessionRevision"("sessionRefId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_orderId_idx" ON "WebhookEvent"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderId_key" ON "Order"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_webhookEventId_key" ON "Order"("webhookEventId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributionSnapshot_orderRefId_key" ON "AttributionSnapshot"("orderRefId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversion_dedupKey_key" ON "Conversion"("dedupKey");

-- CreateIndex
CREATE UNIQUE INDEX "Conversion_orderRefId_provider_key" ON "Conversion"("orderRefId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_conversionRefId_attemptNumber_key" ON "DeliveryAttempt"("conversionRefId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupKey_key" ON "Job"("dedupKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "ReprocessRequest_orderRefId_idx" ON "ReprocessRequest"("orderRefId");

-- AddForeignKey
ALTER TABLE "TrackingSessionRevision" ADD CONSTRAINT "TrackingSessionRevision_sessionRefId_fkey" FOREIGN KEY ("sessionRefId") REFERENCES "TrackingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionSnapshot" ADD CONSTRAINT "AttributionSnapshot_orderRefId_fkey" FOREIGN KEY ("orderRefId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionSnapshot" ADD CONSTRAINT "AttributionSnapshot_sessionRefId_fkey" FOREIGN KEY ("sessionRefId") REFERENCES "TrackingSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_orderRefId_fkey" FOREIGN KEY ("orderRefId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_conversionRefId_fkey" FOREIGN KEY ("conversionRefId") REFERENCES "Conversion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReprocessRequest" ADD CONSTRAINT "ReprocessRequest_orderRefId_fkey" FOREIGN KEY ("orderRefId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
