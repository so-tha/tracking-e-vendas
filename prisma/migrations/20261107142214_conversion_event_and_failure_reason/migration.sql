-- AlterTable
ALTER TABLE "Conversion" ADD COLUMN     "eventSnapshot" JSONB,
ADD COLUMN     "failureReason" TEXT;
