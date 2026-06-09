-- AlterTable
ALTER TABLE "BacktestRun" ADD COLUMN "userId" TEXT;
ALTER TABLE "LiveReplaySession" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "BacktestRun_userId_idx" ON "BacktestRun"("userId");
CREATE INDEX "LiveReplaySession_userId_idx" ON "LiveReplaySession"("userId");

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveReplaySession" ADD CONSTRAINT "LiveReplaySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
