-- Only one non-cancelled deal per need
CREATE UNIQUE INDEX "one_active_deal_per_need"
    ON "Deal" ("needId") WHERE "status" <> 'CANCELLED';

-- Ratings must be 1–5
ALTER TABLE "Review" ADD CONSTRAINT "rating_range"
    CHECK ("rating" BETWEEN 1 AND 5);

-- Money can never be negative
ALTER TABLE "Need" ADD CONSTRAINT "need_amounts_non_negative"
    CHECK ("estimatedPrice" >= 0 AND "thankYouAmount" >= 0);

ALTER TABLE "Deal" ADD CONSTRAINT "deal_amounts_non_negative"
    CHECK (COALESCE("productAmount", 0) >= 0
        AND COALESCE("shippingEstimate", 0) >= 0
        AND COALESCE("shippingActual", 0) >= 0
        AND "thankYouAmount" >= 0);