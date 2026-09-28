-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "productAmount" INTEGER NOT NULL,
    "shippingEstimate" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quote_dealId_createdAt_idx" ON "Quote"("dealId", "createdAt");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only one accepted quote per deal. Written by hand because Prisma cannot
-- express a partial index; the same shape as one_active_deal_per_need.
CREATE UNIQUE INDEX "one_accepted_quote_per_deal"
    ON "Quote" ("dealId") WHERE "acceptedAt" IS NOT NULL;

-- Money can never be negative, here as everywhere else.
ALTER TABLE "Quote" ADD CONSTRAINT "quote_amounts_non_negative"
    CHECK ("productAmount" >= 0 AND "shippingEstimate" >= 0);
