-- AlterTable: add reflectionNote column to JournalEntry
ALTER TABLE "JournalEntry" ADD COLUMN "reflectionNote" TEXT;

-- AlterTable: change JournalEntry → Trade FK to ON DELETE CASCADE
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_tradeId_fkey";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_tradeId_fkey"
    FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: DayNote
CREATE TABLE "DayNote" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DayNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DayNote_date_key" ON "DayNote"("date");
CREATE INDEX "DayNote_date_idx" ON "DayNote"("date");
