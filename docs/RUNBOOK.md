# Backend Runbook

Operational checks for the shamarx-app backend running on EC2.
**Read this when:** you suspect something is broken, you just deployed
something and want to verify, or someone (probably future-you) asks
"is the engine actually working?"

All commands assume:
- AWS SSO logged in: `aws sso login --profile shamarx-prod`
- EC2 instance: `i-0da17ad488fa32c8a`, region `ap-southeast-5`
- Production API: `https://api.shamarx.com`

---

## TL;DR — one command to know if you're OK

```bash
curl -s https://api.shamarx.com/api/strategy/public/pulse | jq .
```

Healthy output looks like this:

```json
{
  "serverNowIso": "2026-05-08T09:30:00.000Z",
  "pairs": {
    "XAUUSD": { "lastEvalAt": "2026-05-08T09:30:00.000Z", "lastDecision": "no-sweep" },
    "EURUSD": { "lastEvalAt": "2026-05-08T09:30:00.000Z", "lastDecision": "no-sweep" },
    "GBPUSD": { "lastEvalAt": "2026-05-08T09:30:00.000Z", "lastDecision": "no-sweep" },
    "USDJPY": { "lastEvalAt": "2026-05-08T09:30:00.000Z", "lastDecision": "no-sweep" }
  },
  "counters": { "evalsToday": 124, "sweepsToday": 0, "signalsToday": 0 },
  "isRunning": true
}
```

**Red flags:**
- `isRunning: false` → engine is paused; start it from the dashboard
- `lastEvalAt` more than 30 min stale on any pair → ingest pipeline likely stuck
- HTTP 500 / connection refused → container down; check `docker compose ps` (below)

---

## Sections

1. [API health](#1-api-health)
2. [Container status](#2-container-status)
3. [Engine state — Redis](#3-engine-state--redis)
4. [Engine state — Postgres](#4-engine-state--postgres)
5. [Live trades + replay sessions](#5-live-trades--replay-sessions)
6. [Logs](#6-logs)
7. [Deploy verification](#7-deploy-verification)
8. [Common scenarios](#8-common-scenarios)

---

## 1. API health

```bash
# Heartbeat
curl -s https://api.shamarx.com/api/strategy/health
# → { "status": "ok", "service": "strategy" }

# Public pulse (no auth) — engine state at a glance
curl -s https://api.shamarx.com/api/strategy/public/pulse | jq .

# Swagger UI (browser)
open https://api.shamarx.com/docs
```

If the bare URL `https://api.shamarx.com/` returns 404 — that's expected
(no NestJS root handler). It is **not** an outage signal. Use `/api/strategy/health` or `/docs`.

---

## 2. Container status

```bash
# All 4 services should be Up + (healthy) where applicable
ssm() {
  local cmd="$1"
  local CID
  CID=$(AWS_PROFILE=shamarx-prod aws ssm send-command \
    --instance-ids i-0da17ad488fa32c8a \
    --document-name "AWS-RunShellScript" \
    --parameters "{\"commands\":[$(printf '%s' "$cmd" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')]}" \
    --region ap-southeast-5 \
    --query 'Command.CommandId' --output text)
  sleep 5
  AWS_PROFILE=shamarx-prod aws ssm get-command-invocation \
    --command-id "$CID" \
    --instance-id i-0da17ad488fa32c8a \
    --region ap-southeast-5 \
    --query 'StandardOutputContent' --output text
}

ssm 'docker compose -f /opt/trading-bot/repo/docker/docker-compose.yml ps'
```

Expected: 4 rows — `trading-bot-app`, `trading-bot-execution` (healthy),
`trading-bot-postgres` (healthy), `trading-bot-redis` (healthy).

Red flags:
- Any row in `Restarting` or `Exited` state
- `RestartCount` > 0 (run `docker inspect <name>` for OOM / exit-code clues)

```bash
# Memory / CPU snapshot
ssm 'docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}"'
```

`trading-bot-app` should sit well under its 2 GiB cap; spikes above
1.5 GiB during a long replay are expected (replay runs in a worker
thread; main eval thread is unaffected).

---

## 3. Engine state — Redis

```bash
# Ping
ssm 'docker exec trading-bot-redis redis-cli ping'
# → PONG

# All live:* keys
ssm 'docker exec trading-bot-redis redis-cli --scan --pattern "live:*"'
```

Expected keys:
- `live:engine:running`, `live:engine:session`, `live:engine:mode`, `live:engine:config`, `live:engine:last-changed-at` — engine control state
- `live:cron:last-poll:{SYM}:{TF}` × 8 — heartbeats from the candle ingest cron
- `live:orchestrator:state` — appears once the engine has processed at least one M15 close (post the proactive-persist deploy)

```bash
# Orchestrator state — pretty-printed per pair
ssm 'docker exec trading-bot-redis redis-cli get live:orchestrator:state' | jq .

# Just the RiskManager block for one pair
ssm 'docker exec trading-bot-redis redis-cli get live:orchestrator:state' | jq .EURUSD.riskManager
```

Red flags on `riskManager.*`:
- `hardKilled: true` → engine is permanently disarmed (≥40% drawdown). Manual reset only.
- `consecutiveLossPauseUntil: "2026-..."` future date → engine is in the
  escalating-loss pause window
- `equityDdPauseUntil: "2026-..."` future date → drawdown brake active
- `dailyPnl: <-30 or so>` → close to the daily-loss circuit breaker

```bash
# Cron heartbeat freshness — should be within last ~60s for active hours
ssm 'docker exec trading-bot-redis redis-cli get live:cron:last-poll:EURUSD:M15'
```

If the heartbeat is more than 3-5 minutes stale, the candle-ingest cron
is stuck. Check its container.

---

## 4. Engine state — Postgres

```bash
# Quickest sanity check — recent candle freshness across all 4 pairs
ssm 'docker exec trading-bot-postgres psql -U trading -d shamarx -c "
SELECT symbol, COUNT(*) AS rows_48h, MAX(\"openTime\") AS newest
FROM \"Candle\" WHERE timeframe = '\''M15'\'' AND \"openTime\" >= NOW() - INTERVAL '\''48 hours'\''
GROUP BY symbol ORDER BY symbol;"'
```

Expected: 4 rows, ~190 candles per pair (24h × 4 candles/hour × 2 days,
minus weekend gaps), `newest` within ~15 minutes of now.

```bash
# Live sessions — control history
ssm 'docker exec trading-bot-postgres psql -U trading -d shamarx -c "
SELECT \"startedAt\", \"endedAt\", mode, \"riskPercent\", \"tradesCount\", status
FROM \"LiveSession\" ORDER BY \"startedAt\" DESC LIMIT 5;"'

# Latest replay sessions
ssm 'docker exec trading-bot-postgres psql -U trading -d shamarx -c "
SELECT id, \"startDate\", \"endDate\", \"initialBalance\", \"riskPercent\",
       \"tradesCount\", \"realizedPnl\", status
FROM \"LiveReplaySession\" ORDER BY \"createdAt\" DESC LIMIT 5;"'
```

---

## 5. Live trades + replay sessions

```bash
# Recent live trades (real broker fills only)
ssm 'docker exec trading-bot-postgres psql -U trading -d shamarx -c "
SELECT \"createdAt\", symbol, side, status, \"exitReason\", pnl, \"closedAt\"
FROM \"Trade\" WHERE \"clientOrderId\" IS NOT NULL
ORDER BY \"createdAt\" DESC LIMIT 25;"'

# Replay trades for a specific session
ssm 'docker exec trading-bot-postgres psql -U trading -d shamarx -c "
SELECT symbol, side, \"lotSize\", \"entryPrice\", \"closePrice\", \"exitReason\", pnl
FROM \"LiveReplayTrade\"
WHERE \"sessionId\" = '\''<UUID>'\''
ORDER BY \"openedAt\";"'
```

Diagnostic note: if a replay shows `exitReason = FORCED_CLOSE`, that
position was still open when the replay window ended — the engine
closes everything at the last available candle. Force-closed P&L is a
*snapshot*, not a resolved win/loss. See `docs/replay-analysis-*` for
context.

---

## 6. Logs

```bash
# App logs (last 200 lines)
ssm 'docker logs --tail 200 trading-bot-app 2>&1'

# Just the last 10 minutes, errors only
ssm 'docker logs --since 10m trading-bot-app 2>&1 | grep -iE "error|warn|fatal" | tail -30'

# Execution-service logs (broker / MetaApi connector)
ssm 'docker logs --tail 100 trading-bot-execution 2>&1'
```

Common warnings that are NOT bugs:
- `Cannot GET /` — bots / scanners hitting the bare root URL
- `Unauthorized` — frontend pre-auth call before login redirect
- `Could not persist orchestrator state: ...` (transient) — Redis blip,
  next debounce / interval tick retries

Things to investigate:
- `JavaScript heap out of memory` → bump `mem_limit` in compose
- `psql: error: connection to server ... failed` → postgres restart loop
- Repeating `placeOrder failed` → broker connectivity / MetaApi creds

---

## 7. Deploy verification

After a GHA `Deploy backend` run completes:

```bash
# 1. Confirm the container is on the new commit
ssm 'cd /opt/trading-bot/repo && git log --oneline -1'

# 2. Confirm the new code is in the compiled JS
# (replace the grep pattern with whatever your change introduced)
ssm 'docker exec trading-bot-app sh -c "grep -n <symbol> dist/src/<path>.js | head -5"'

# 3. Health check
curl -s https://api.shamarx.com/api/strategy/health
curl -s https://api.shamarx.com/api/strategy/public/pulse | jq .isRunning

# 4. Watch the next M15 boundary (UTC :00, :15, :30, :45) — pulse counters should increment
```

For the most recent persistence work, the markers are:

```bash
# Confirms RiskManager.snapshot() compiled
ssm 'docker exec trading-bot-app sh -c "grep -n \"^[[:space:]]*snapshot()\" dist/src/backtest/engine/risk-manager.js"'

# Confirms orchestrator wires it through
ssm 'docker exec trading-bot-app sh -c "grep -n riskManager dist/src/strategy/live/live-smc-orchestrator.js"'

# Confirms the proactive-persist scheduler
ssm 'docker exec trading-bot-app sh -c "grep -n markPersistDirty dist/src/strategy/live/live-strategy.service.js"'
```

---

## 8. Common scenarios

### Post-deploy: am I sure live trading is intact?

```bash
# Live session row should still be RUNNING (not ENDED) and same id as before deploy
ssm 'docker exec trading-bot-postgres psql -U trading -d shamarx -c "
SELECT id, \"startedAt\", status FROM \"LiveSession\" WHERE status = '\''RUNNING'\'';"'

# Pulse counters should resume (note: in-memory, reset on restart; just confirm they grow)
curl -s https://api.shamarx.com/api/strategy/public/pulse | jq .counters

# Open positions at broker (proxied through execution-service)
curl -s https://api.shamarx.com/api/strategy/live/positions
```

### Engine looks dormant — no signals for hours

This is the **most common false alarm**. stop-hunt sweeps are rare by design.

Verify in order:
1. `isRunning: true` in pulse
2. `evalsToday` > 0 and growing every 15 minutes (~16/hour)
3. `lastEvalAt` is fresh (< 16 min ago) for all 4 pairs
4. Redis `live:orchestrator:state.*.riskManager.hardKilled` is `false`
5. No `consecutiveLossPauseUntil` / `equityDdPauseUntil` in the future

If all green, the engine is correctly **rejecting** rather than firing.
The replay theatre on identical historical data confirms the strategy
logic works. stop-hunt sweeps land roughly 0-3× per pair per day.

### Replay shows different P&L vs live

A few common causes (none are bugs):

1. **Replay window cut off mid-trade** — short replays force-close any
   still-open positions at the last candle. P&L is a snapshot, not a
   resolved outcome. Lengthen the `endDate` and re-run.
2. **Live wasn't running when the M15 close happened** — past M15 closes
   are never backfilled at engine startup. Check `LiveSession.startedAt`
   vs the trade's `openedAt`.
3. **Different `initialBalance` between replays** — lot sizing depends
   on equity. Same setups → different lot sizes → different absolute $
   P&L.

### Redis flushed / state lost

Redis is the source of truth for orchestrator runtime state. If
`live:orchestrator:state` disappears (manual flush, Redis container
recreate, etc.):

1. The next M15 evaluation rebuilds the per-pair `pending`,
   `actionedSweeps`, `cooldown` state freshly — equivalent to a clean
   container start. Nothing breaks; you just lose the prior session's
   pending sweep queue.
2. RiskManager state (consecutive losses, daily PnL, drawdown brake)
   resets to zero. Safety brakes that were active are erased — same as
   a pre-persistence-fix container restart.
3. To rebuild RiskManager from prior trades, restart the trading-bot
   container — `position-monitor.recordExit` will replay recent closed
   trades from the broker reconciliation loop. Not perfect but better
   than nothing.

To minimise risk: don't `redis-cli flushdb` in production unless
absolutely necessary. The `live:orchestrator:state` key is small
(<10 KB even with 30 days of trade log) — there's no reason to clear it.

---

## Useful one-liners

```bash
# Watch pulse live (refresh every 5s)
watch -n 5 'curl -s https://api.shamarx.com/api/strategy/public/pulse | jq "{isRunning, counters, pairs}"'

# Tail app logs from local terminal (need SSM session-manager-plugin installed)
AWS_PROFILE=shamarx-prod aws ssm start-session --target i-0da17ad488fa32c8a --region ap-southeast-5 \
  --document-name AWS-StartInteractiveCommand \
  --parameters command="docker logs -f trading-bot-app"

# Total live trades ever
ssm 'docker exec trading-bot-postgres psql -U trading -d shamarx -tAc "SELECT COUNT(*) FROM \"Trade\" WHERE \"clientOrderId\" IS NOT NULL;"'

# All replay sessions (count + total realized PnL)
ssm 'docker exec trading-bot-postgres psql -U trading -d shamarx -tAc "SELECT COUNT(*), SUM(\"realizedPnl\") FROM \"LiveReplaySession\" WHERE status = '\''COMPLETED'\'';"'

# Force-restart the trading-bot container (preserves Redis state — orchestrator restores)
ssm 'docker compose -f /opt/trading-bot/repo/docker/docker-compose.yml restart trading-bot'
```

---

## When you really can't tell — escalation order

1. Run section 1 + section 2 → narrows to "API down" vs "engine logic"
2. Run section 6 with `--since 30m` → recent errors / repeating warnings
3. Run section 3 + section 4 → state inspection
4. If still stuck: the GHA Deploy backend workflow has a "Health check" step
   that will refuse to mark the deploy green if `/api/strategy/health`
   doesn't respond — re-run the latest deploy run as a clean reset
   (it's idempotent: `git reset --hard origin/main` + `docker compose up
   -d --build`)
