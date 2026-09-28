-- One OPEN report per person per target. Written by hand: Prisma cannot express
-- a partial index, and without the WHERE clause somebody could never report the
-- same thing twice, however long ago the first report was resolved.
CREATE UNIQUE INDEX "one_open_report_per_reporter_target"
    ON "Report" ("reporterId", "targetType", "targetId")
    WHERE "status" = 'OPEN';
