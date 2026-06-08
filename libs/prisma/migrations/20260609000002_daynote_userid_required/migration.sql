-- Drop existing unique index on date alone
DROP INDEX IF EXISTS "DayNote_date_key";
ALTER TABLE "DayNote" DROP CONSTRAINT IF EXISTS "DayNote_date_key";

-- Tighten userId to NOT NULL
ALTER TABLE "DayNote" ALTER COLUMN "userId" SET NOT NULL;

-- New unique on (userId, date)
CREATE UNIQUE INDEX "DayNote_userId_date_key" ON "DayNote"("userId", "date");
