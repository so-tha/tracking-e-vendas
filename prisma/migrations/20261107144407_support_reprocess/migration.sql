-- DropForeignKey
ALTER TABLE "ReprocessRequest" DROP CONSTRAINT "ReprocessRequest_orderRefId_fkey";

-- AlterTable
ALTER TABLE "ReprocessRequest" ADD COLUMN     "orderId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "summary" JSONB,
ALTER COLUMN "orderRefId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ReprocessRequest_orderId_idx" ON "ReprocessRequest"("orderId");

-- AddForeignKey
ALTER TABLE "ReprocessRequest" ADD CONSTRAINT "ReprocessRequest_orderRefId_fkey" FOREIGN KEY ("orderRefId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
