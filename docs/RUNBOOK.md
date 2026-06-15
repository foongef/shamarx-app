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

Expected: 5 rows — `trading-bot-app`, `trading-bot-execution` (healthy),
`trading-bot-postgres` (healthy), `trading-bot-redis` (healthy), and the
`trading-bot-autoheal` sidecar (no healthcheck of its own; just `Up`).

Red flags:
- Any row in `Restarting` or `Exited` state
- `trading-bot-execution` showing `(unhealthy)` — autoheal will restart it
  within ~60s; if you still see unhealthy 2 minutes later, autoheal itself
  is broken, see below
- `RestartCount` > 0 on `trading-bot-execution` — autoheal kicked in
  recently. Check `docker logs trading-bot-autoheal` to see what it did
  and `docker logs trading-bot-execution` for the *prior* run's tail
- Frequent restarts (>3/hour) on `trading-bot-execution` → not a stuck
  loop but a recurring problem, investigate root cause (MetaApi auth,
  network, OOM)

### Auto-recovery: how the watchdog works

`willfarrell/autoheal` polls the Docker daemon every 30s. For each
container labelled `autoheal: 'true'` (currently just execution-service)
whose health is `unhealthy`, it issues a `docker restart`. The
execution-service container is opted in because its asyncio event loop
can be starved by a pathological MetaApi WebSocket retry state — in that
mode the process is alive but uvicorn cannot accept connections, and
`restart: unless-stopped` would leave it stuck forever (it only fires on
exit, not on health failure).

End-to-end timing of an automatic recovery:

| Step | Time after fault |
|---|---|
| `/health` returns 503 (no successful op in 5 min) | T+5m00s |
| Docker marks container `unhealthy` (5 consecutive failures × 10s) | T+5m50s |
| autoheal poll detects, issues restart | T+6m20s (avg) |
| Container back to `(healthy)` with fresh MetaApi session | T+6m40s |

Tune via env: `AUTOHEAL_INTERVAL` (sidecar poll period),
`HEALTH_STALE_THRESHOLD_SEC` (staleness gate in execution-service).

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

## Multi-Account Broker Operations

### Master encryption key (production = AWS Secrets Manager)

`CryptoService` uses **dual-mode** key sourcing:

| Env set | Behavior |
|---|---|
| `BROKER_CREDS_SECRET_ID` | Fetch key from AWS Secrets Manager at boot (production) |
| `BROKER_CREDS_KEY` | Use as 32-byte hex directly (local dev) |

The Terraform module `envs/prod` creates an empty Secrets Manager resource at:

```
shamarx-prod-broker-creds-master-key
```

EC2 role is granted `secretsmanager:GetSecretValue` on its ARN.
The secret VALUE is **not** managed by Terraform — set it once after
`terraform apply`:

```bash
aws secretsmanager put-secret-value \
  --profile shamarx-prod \
  --region ap-southeast-5 \
  --secret-id shamarx-prod-broker-creds-master-key \
  --secret-string "$(openssl rand -hex 32)"
```

This keeps the key off your laptop and out of git. Lost key = all
encrypted creds become unrecoverable; users must re-enter broker creds
via the UI.

### Rotating the master key

1. Pick a downtime window.
2. Fetch the current key:
   ```bash
   OLD_KEY=$(aws secretsmanager get-secret-value \
     --profile shamarx-prod --region ap-southeast-5 \
     --secret-id shamarx-prod-broker-creds-master-key \
     --query SecretString --output text)
   ```
3. SSH onto the app server. For each `BrokerAccount` row, decrypt
   `encryptedCreds` with `$OLD_KEY`, re-encrypt with a new key,
   `UPDATE BrokerAccount SET encryptedCreds = ..., credsIv = ..., credsAuthTag = ...`.
4. `put-secret-value` the new key into Secrets Manager (uses `Pending`
   stage automatically; promote to `Current` after verifying).
5. Restart the app container — picks up the new key.
6. Verify with a no-op order on a mock account.

No automated rotation tool in v1. The above is manual; expect SOC2 to
push this onto a quarterly cadence eventually.

### Enabling fan-out

After the schema migration deploys and `scripts/backfill-broker-accounts.ts`
runs successfully, set `ENABLE_MULTI_ACCOUNT_FANOUT=true` in production
`.env` and restart the app container.

To roll back: set to `false` and restart. The strategy engine reverts
to legacy single-account behavior using the env-driven MetaApi creds.

### Soft cap

`MULTI_ACCOUNT_SOFT_CAP` defaults to 5. To raise it, set the env var
and restart. Higher caps mean more concurrent broker connections —
monitor MetaApi rate limits per account.

### Running the backfill script

After schema deploys (auto-applied by `prisma db push` in
`deploy-backend.yml`):

```bash
aws ssm send-command --profile shamarx-prod --region ap-southeast-5 \
  --instance-ids i-0da17ad488fa32c8a \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/trading-bot/repo && docker compose -f docker/docker-compose.yml exec -T trading-bot pnpm ts-node -P tsconfig.build.json --transpile-only scripts/backfill-broker-accounts.ts"]'
```

Idempotent — re-running skips already-assigned rows.

---

## Inviting a friend (Spec 2 — multi-tenant)

1. Log in as SUPERADMIN at the web app.
2. Sidebar → ADMIN → Invites.
3. Enter friend's email + expiry (default 7 days) → click "+ New invite".
4. The page shows the one-time `/join/<token>` link in a callout. The email also goes out via SMTP — share whichever channel you prefer.
5. Friend opens the link, sets password + picks preset, lands on `/dashboard`.

### Managing users

- ADMIN → Users — toggle a user's Active status (revokes their refresh tokens) or Bot Enabled status.
- ADMIN → Invites → Revoke — invalidates a pending invite immediately.
- ADMIN → Sessions — shows active refresh tokens; revoke to force re-login on a specific device.
- ADMIN → Engine → Type `PAUSE-ALL` → click "Pause everyone" — emergency stop for all USER bots. Reversible per-user from the Users page.

## Production rollout for Spec 2

Pre-flight (one-time, before any friend invite):

1. Apply migrations to production DB. Push to main runs `prisma db push` automatically; manual migrations in `libs/prisma/migrations/` will be applied.
2. Run the backfill on production:
   ```bash
   ssh ec2-user@<host>
   docker exec trading-bot-app npx ts-node scripts/backfill-spec2.ts
   ```
   Expected: "Backfilled N DayNote rows" and "Ensured <your-email> has presetKey=BALANCED".
3. Verify your account:
   ```bash
   docker exec trading-bot-db psql -U postgres -c \
     'SELECT email, role, "botEnabled", "presetKey" FROM "User";'
   ```
   Expect: `role=SUPERADMIN, botEnabled=true, presetKey=BALANCED`.

Smoke test (no friends yet):

4. Log into the web app — dashboard should show your equity hero, status pill green ("Bot live · Balanced"), preset switcher in sidebar.
5. Wait for the next M15 signal — verify a trade fires with no behavior change vs pre-Spec-2.
6. Sidebar → ADMIN should be visible (SUPERADMIN gate).

Inviting first friend:

7. ADMIN → Invites → "+ New invite" with their email.
8. They click the link, set password + preset, get redirected to their dashboard.
9. ADMIN → Users — verify the new row, their `accountsTotal` is 0 until they add a broker account.

## Spec 2.5 — Dashboard analytics rollout

Pre-flight (one-time, after merge):

1. Backend PR merges → `prisma db push` on EC2 applies the 3 schema additions (`userId` on `BacktestRun` + `LiveReplaySession`; `pausedAt` on `User`).
2. Run backfill via SSM:
   ```bash
   docker exec trading-bot-app npx ts-node scripts/backfill-spec2-5.ts
   ```
   Expected output: "Backfilled N BacktestRun rows" + "Backfilled N LiveReplaySession rows".
3. Verify scoping:
   ```bash
   docker exec trading-bot-postgres psql -U trading shamarx -c \
     'SELECT COUNT(*) AS total, COUNT("userId") AS scoped FROM "BacktestRun";'
   ```
   total should equal scoped.

Smoke after web deploys:

4. Visit /dashboard → see Spacious layout. Live status panel (left) + Performance hero (right). Full-width equity curve. Snapshot tiles + Today's trades. SUPERADMIN: house view appended below.
5. Sidebar shows Backtest + Replay in WORKSPACE; ADMIN section has "All Backtests".
6. Open /admin/backtest → see all historical runs attributed to you.
7. Open /admin/users/<id> for any user → see Snapshot drill-in.

Rollback:
- Backend: redeploy previous main; nullable columns linger harmlessly.
- Web: redeploy previous Amplify build.

---

## cTrader OAuth (Spec 3)

ShamarX supports cTrader (via Spotware Open API) alongside MetaApi. Friends
onboard at `/accounts/new` and never see a password field — the OAuth flow
delegates auth to Spotware.

### One-time Spotware app registration

1. Sign in at https://openapi.ctrader.com using the team Spotware account.
2. **Apps → Add new application**.
3. Settings:
   - **Name:** Shamarx
   - **Redirect URI (prod):** `https://shamarx.com/oauth/ctrader/callback`
   - **Redirect URI (dev):** `http://localhost:3000/oauth/ctrader/callback`
   - **Scopes:** `trading`, `accounts`
4. Save the **Client ID** and **Client Secret**. Put them in AWS Secrets Manager:

   ```bash
   aws secretsmanager create-secret \
     --name shamarx/ctrader-oauth \
     --description "Spotware OAuth app credentials (Spec 3)" \
     --secret-string '{"client_id":"<id>","client_secret":"<secret>"}' \
     --region ap-southeast-5
   ```

5. Grant the EC2 instance role read access:

   ```bash
   aws iam attach-role-policy \
     --role-name <shamarx-app-role> \
     --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite
   ```

   (Or, narrower: add an inline policy scoped to the secret ARN.)

6. Set `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, and
   `CTRADER_REDIRECT_URI` in the production env (`/etc/shamarx/.env` or
   wherever the backend reads from). Trigger a redeploy so the backend
   picks them up.

### Verifying the flow end-to-end

```bash
# 1. Get an authUrl as a real user.
curl -s -H "Authorization: Bearer $JWT" \
  https://api.shamarx.com/api/broker-accounts/ctrader/oauth/start | jq .
```

Expected: `{ "authUrl": "https://connect.spotware.com/apps/auth?…", "state": "..." }`.

Open `authUrl` in a browser → grant consent on Spotware → it redirects to
`/oauth/ctrader/callback?code=…&state=…` on the web app. The client-side
trampoline POSTs to `/api/broker-accounts/ctrader/callback`, gets a
`sessionId`, and routes to `/accounts/new/pick?sid=…`. Pick an account,
hit Confirm → a BrokerAccount row is created.

### Token refresh

cTrader access tokens expire (typically 30 days). The Python
`CTraderClient._with_reconnect` handles refresh:

- **Proactive:** when `expiresAt < now + 60s`, refresh before the next request.
- **Reactive:** on `CH_CLIENT_AUTH_FAILURE`, refresh + retry once.

After a successful refresh, the client PATCHes the new tokens to
`/api/accounts/:id/oauth-tokens` (internal-IP only) so they're re-encrypted
and persisted in the `BrokerAccount` row.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `OAuth state expired or invalid` | User took >10 min on Spotware | Restart from `/accounts/new`. |
| `OAuth session expired` | User took >30 min to pick + confirm | Restart from `/accounts/new`. |
| `This account is already connected` | `ctidTraderAccountId` collision | `SELECT * FROM "BrokerAccount" WHERE "accountNumber" = ? AND broker = 'CTRADER'` |
| Continuous `CH_CLIENT_AUTH_FAILURE` after refresh | Spotware revoked the app or user | User must re-OAuth via `/accounts/new`. |
| `InternalIpGuard: rejected request from <ip>` | execution-service not on the docker network | Check `docker compose ps` — both services must be on the same bridge. |


## Spec 3 production rollout checklist

- [ ] Register Spotware app, save Client ID/Secret to AWS Secrets Manager (`shamarx/ctrader-oauth`)
- [ ] EC2 role can read the secret (`secretsmanager:GetSecretValue` on the secret ARN)
- [ ] Set `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, `CTRADER_REDIRECT_URI` in the backend env
- [ ] Push to main → CI deploys backend + web + execution-service (auto-runs `prisma db push`)
- [ ] Verify schema landed:
  ```sql
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'BrokerAccount'
    AND column_name IN ('accountNumber', 'accountKind', 'brokerName', 'oauthExpiresAt');
  -- expect 4 rows
  ```
- [ ] Smoke the API: `curl -H "Authorization: Bearer $JWT" https://api.shamarx.com/api/broker-accounts/ctrader/oauth/start` returns an `authUrl`
- [ ] Walk through `/accounts/new` in a real browser end-to-end (use a Spotware demo account first)
- [ ] Confirm the new `BrokerAccount` row has: encrypted creds, `accountNumber`, `accountKind = DEMO`, `oauthExpiresAt` set
- [ ] Account stays `isEnabled = false` by default — toggle on only after manual smoke
- [ ] Wait for next M15 close → engine fans out to the cTrader account via existing fan-out gate (Spec 2 Task 10)
- [ ] If signals fire, verify trade lands; if no signal, `GET /api/me/snapshot` shows no errors from the broker call
- [ ] Existing MetaApi accounts are untouched (regression canary)

## MT5 Direct (Spec 4)

Self-hosted MT5 bridge. Architecture: `docs/architecture/mt5-direct-architecture.html`.

**Host:** `mt5-host-01` · `i-0357e694bbc4ed0a7` · private `10.0.2.48:8100` · t3.medium Windows · subnet AZ b.
Terraform: `shamarx-terraform/modules/mt5-host`. NO public ingress; admin via SSM only.

**Services (NSSM):** `shamarx-mt5-manager` (FastAPI :8100) + `shamarx-mt5-watchdog`.
Restart: `aws ssm send-command --document-name AWS-RunPowerShellScript --instance-ids i-0357e694bbc4ed0a7 --parameters 'commands=["Restart-Service shamarx-mt5-manager"]' --region ap-southeast-5 --profile shamarx-prod`
Logs on host: `C:\shamarx-etc\manager.{log,err}`, `watchdog.{log,err}`.

**Capacity / scale decision:** `pnpm host:stats -- mt5-host-01` (manager `/capacity` verdict is authoritative). Admin API: `GET /api/admin/mt5-hosts`.

**Code deploy to host:** `cd C:\shamarx; git pull --ff-only; Restart-Service shamarx-mt5-manager` via SSM. Code lives in this repo `services/mt5-host/`, sparse-checked-out.

**Golden template rebuild:** download `mt5setup.exe` (MetaQuotes CDN) on the host, silent-install to a scratch dir, run once with `/portable` (no login), close, zip the folder to `C:\shamarx-mt5\golden-template.zip`. Keep charts/news/sounds minimal before zipping.

**Heartbeats:** Redis `live:mt5host:<hostId>:<accountId>` (TTL 300s) via `POST /api/internal/mt5-heartbeat`. Watchdog needs `APP_INTERNAL_URL` in `C:\shamarx-etc\manager.env`.

**Patch window:** Windows Update Sun 22:00 UTC; services auto-start, watchdog resumes the fleet.

### Parallel-run promotion checklist (before migrating the primary account)
- [ ] Operator demo onboarded via wizard (MT5 Direct) alongside the MetaApi account, same MT5 login
- [ ] 1–2 weeks elapsed
- [ ] Zero unexplained fill divergence between the two rails
- [ ] Candle parity ≥99.9% vs the Candle table
- [ ] No watchdog 3-strike alerts for 7 consecutive days
- [ ] Then: disable MetaApi BrokerAccount, MT5 Direct becomes primary, wizard opened to friends
