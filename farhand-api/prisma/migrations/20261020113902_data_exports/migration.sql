-- CreateTable
CREATE TABLE "DataExport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" JSONB,
    "readyAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataExport_userId_createdAt_idx" ON "DataExport"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DataExport_expiresAt_idx" ON "DataExport"("expiresAt");

-- AddForeignKey
ALTER TABLE "DataExport" ADD CONSTRAINT "DataExport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
