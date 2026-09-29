-- AlterTable
ALTER TABLE "AdminAction" ADD COLUMN     "contentId" TEXT,
ADD COLUMN     "contentType" "ReportTarget";

-- CreateIndex
CREATE INDEX "AdminAction_contentType_contentId_idx" ON "AdminAction"("contentType", "contentId");
