-- AlterEnum
ALTER TYPE "ReportTarget" ADD VALUE 'REVIEW';

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "removedAt" TIMESTAMP(3);
