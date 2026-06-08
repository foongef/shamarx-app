-- AlterTable
ALTER TABLE "DayNote" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "DayNote_userId_idx" ON "DayNote"("userId");

-- AddForeignKey
ALTER TABLE "DayNote" ADD CONSTRAINT "DayNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
