-- AlterTable
ALTER TABLE "Help" ADD COLUMN     "prohibitedAckAt" TIMESTAMP(3),
ADD COLUMN     "prohibitedVersion" VARCHAR(64);

-- AlterTable
ALTER TABLE "Need" ADD COLUMN     "prohibitedAckAt" TIMESTAMP(3),
ADD COLUMN     "prohibitedVersion" VARCHAR(64);

-- CreateTable
CREATE TABLE "ProhibitedItem" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "position" INTEGER NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProhibitedItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProhibitedItem_slug_key" ON "ProhibitedItem"("slug");

-- CreateIndex
CREATE INDEX "ProhibitedItem_retiredAt_position_idx" ON "ProhibitedItem"("retiredAt", "position");
