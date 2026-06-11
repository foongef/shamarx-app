# MT5 Direct — Self-Hosted Bridge Design Spec

**Status:** Draft for review
**Date:** 2026-06-11
**Position:** Spec 4. Companion to the visual architecture draft at `docs/architecture/mt5-direct-architecture.html` (approved 2026-06-11).
**Scope:** Single spec → single plan. The W1/W2 build phases are tasks within one plan, not sub-specs.

## 1. Goal

Replace the MetaApi cloud bridge with a self-hosted MT5 connection layer: one Windows EC2 running a fleet of portable MT5 terminals behind a `terminal-manager` service, exposed to the platform as a new `MT5_DIRECT` backend on the existing `Broker` ABC. Friends onboard MT5 accounts through the existing wizard with zero human involvement; the operator gets one-command capacity visibility for scale decisions.

Motivation: three MetaApi infrastructure outages in eight days (2026-06-03..10), ~$30–50/account/month MetaApi cost vs ~$9–12 self-hosted, and full custody of the reliability story.

## 2. Decisions captured during design

| # | Decision | Reason |
|---|---|---|
| 1 | One terminal instance per account (portable mode), one Python worker per terminal | The official `MetaTrader5` lib binds process-globally; a terminal holds exactly one login. Isolation is forced by the platform, so embrace it. |
| 2 | Phase 1 on `t3.small` Windows (~$37/mo, 3–4 terminals) | User constraint: save money now. Resize-in-place to `t3.large` is the documented Phase 2; no architectural change. |
| 3 | Zero public ingress on the Windows host | SG allows :8100 from the app server's SG only; admin via SSM Session Manager (no RDP, no public IP). Matches how the Linux box is managed. |
| 4 | Shared-secret header auth between app and manager (Phase 1); mTLS deferred | Private-VPC + SG scoping is the real boundary; the header is defense-in-depth. mTLS cost isn't justified until friends' LIVE accounts ride this rail. |
| 5 | `Mt5Host` registry table exists from day 1 with one row | The Phase 2/3 shard key (`BrokerAccount.hostId`) must be in the schema before data accumulates. Costs one migration now, saves a backfill later. |
| 6 | Golden-template provisioning (zip of pristine portable MT5) | Deterministic terminals; template versioning makes terminal upgrades deliberate fleet rollouts. |
| 7 | Login verification is synchronous and fail-fast (90s budget) | A bad password must clean up the terminal folder AND the BrokerAccount row, returning 401 to the wizard. No zombie terminals, no orphan rows. |
| 8 | Capacity stats: manager `GET /capacity` + admin API + `scripts/host-stats.sh` | User requirement: "easy command to check if the EC2 can support more accounts or should scale up." Single source of truth on the manager; consumed by both the dashboard and a one-liner ops script. |
| 9 | Parallel-run gate before migrating the primary account | The user's own demo runs on MetaApi AND MT5 Direct simultaneously for 1–2 weeks; migrate only after fill/candle/uptime parity. |
| 10 | Candles from MT5 Direct workers feed the same `Candle` table | Second independent candle source behind the unified-candle-source fix (commit ef4646b). The ingestion cron gains a per-broker source preference. |

## 3. Architecture

See `docs/architecture/mt5-direct-architecture.html` §2 for the diagram. Components:

| Component | Where | Responsibility |
|---|---|---|
| `terminal-manager` | Windows host, FastAPI :8100 | Provision/destroy terminals from golden template; route per-account Broker verbs to workers; report capacity; enforce capacity cap (reject provisioning beyond RAM headroom). |
| `worker` (×N) | Windows host, 1 process/terminal | Binds `MetaTrader5` lib to its terminal path. Implements: init, order, positions, modify, close, account-info, position-close-info, candles. Speaks JSON over a local port assigned by the manager. |
| `watchdog` | Windows host, service | 30s loop: terminal process alive, worker IPC responsive, broker connection state. Restart w/ backoff 1m→2m→4m→cap 15m. Heartbeat per terminal → Redis (`live:mt5host:<hostId>:<accountId>`) via the manager's outbound call to the app's internal endpoint. |
| `Mt5DirectClient` | execution-service | `Broker` ABC implementation; HTTP to manager `/t/:accountId/*`. Registry dispatches on `broker='MT5_DIRECT'`. |
| `Mt5Host` table | Postgres | `id, name, privateIp, port, capacity, status('ACTIVE'\|'DRAINING'\|'DOWN'), createdAt`. `BrokerAccount.hostId String?` FK. |
| Provisioning orchestration | NestJS `Mt5HostService` | Host selection (least-loaded ACTIVE with headroom), provision call, rollback on failure, deprovision on account delete. |
| Wizard branch | shamarx-web | "MT5 Direct" card in `/accounts/new` → form: login, password, server, name + custody disclosure. |
| `scripts/host-stats.sh` | repo | One-command capacity/health check (see §7). |

### 3.1 Manager API contract

All requests require header `X-Manager-Secret: <from AWS Secrets Manager shamarx/mt5-manager-secret>`.

| Method | Path | Body / Returns |
|---|---|---|
| POST | `/terminals` | `{accountId, login, password, server}` → 201 `{status:'CONNECTED', equity, balance}` \| 401 bad creds \| 409 fleet full \| 504 login timeout |
| DELETE | `/terminals/:accountId` | 204; idempotent |
| GET | `/health` | `{status, terminals:[{accountId, state, uptimeS, restarts}]}` |
| GET | `/capacity` | see §7 schema |
| POST | `/t/:accountId/orders` | Broker ABC order verb (mirrors execution-service account-scoped routes) |
| GET | `/t/:accountId/positions` | … |
| POST | `/t/:accountId/positions/:ticket/modify` | … |
| POST | `/t/:accountId/positions/:ticket/close` | … |
| GET | `/t/:accountId/account-info` | … |
| GET | `/t/:accountId/positions/:ticket/history` | … |
| GET | `/t/:accountId/candles?timeframe&count` | OHLCV list (closed bars only — worker drops the forming bar) |

### 3.2 Creds shape (encrypted, existing CryptoService)

```json
// MT5_DIRECT
{ "login": "52867017", "password": "…", "server": "ICMarketsSC-Demo" }
```

`resolve_client` passes creds through unchanged; `Mt5DirectClient.from_creds` reads `brokerAccountId` (the Spec 3 convention) to address `/t/:accountId/*`.

## 4. Onboarding flow (automated)

1. Wizard `/accounts/new` → "MT5 Direct" card → form (login/password/server/name) + plain-words custody disclosure.
2. `POST /api/accounts {broker:'MT5_DIRECT', mode:'metaapi', creds:{login,password,server}, name}` → encrypt → row (`isEnabled=false`, `hostId=null`).
3. NestJS `Mt5HostService.provision(accountId)`: select host → decrypt creds → `POST manager/terminals` → on 201: set `hostId`, `lastConnectedAt`, honor wizard's enable checkbox. On 401/409/504: delete the row, surface the error verbatim to the wizard.
4. Engine fans out at next M15 close (existing Spec 2 gate).
5. Account delete → existing open-trades guard → `DELETE manager/terminals/:id` → row delete, capacity freed.

## 5. Security posture

- **Network:** no public IP; SG ingress :8100 ← app-server SG only; egress 443/broker ports. SSM-managed (no RDP listener; RDP via SSM port-forward when a GUI is unavoidable).
- **Secrets:** `shamarx/mt5-manager-secret` (random 32B) in AWS Secrets Manager; read by both app (env) and host (instance role). Same Terraform pattern as `shamarx/ctrader-oauth`.
- **At rest:** EBS encryption on; passwords land only in terminal config; never logged; folder shredded on deprovision.
- **Custody:** wizard discloses master-password custody before submission. (Intrinsic to any MT5 bridge — MetaApi holds it today.)
- **Patching:** Windows Update window Sun 22:00 UTC; watchdog auto-resumes the fleet post-reboot.

## 6. Stability mechanics

| Failure | Detection | Recovery |
|---|---|---|
| Terminal crash | watchdog 30s | relaunch + auto-login; backoff on flap; 3 strikes → Redis alert (DEGRADED pill) |
| Worker hang | IPC ping timeout | kill + respawn worker (terminal untouched) |
| Broker disconnect | terminal state | MT5 native reconnect; escalate >5 min |
| Host down | Redis heartbeat TTL (300s) | dashboard DEGRADED; SL/TP safe broker-side; rebuild from nightly AMI ≈15 min |
| Capacity exhaustion | manager cap check | provisioning 409 "fleet full" — never OOM-oversubscribes |

The 3-strike absence-confirmation reconciliation (commit 5785254) applies to MT5 Direct unmodified.

## 7. Capacity stats — the "should I scale?" command

**Single source of truth:** `GET manager/capacity`:

```json
{
  "hostId": "mt5-host-01",
  "instanceType": "t3.small",
  "memory":   { "totalMb": 2048, "usedMb": 1490, "freeMb": 558 },
  "cpu":      { "load1m": 0.41, "load15m": 0.36 },
  "disk":     { "totalGb": 50, "freeGb": 31 },
  "terminals":{ "running": 3, "capacity": 4, "avgRssMb": 410 },
  "headroom": { "additionalAccounts": 1 },
  "verdict":  "NEAR_CAPACITY",
  "recommendation": "1 slot left. At 4/4, resize to t3.medium (stop→resize→start, ~10 min) or add mt5-host-02."
}
```

Verdict thresholds: `OK` (<70% of capacity AND freeMb > 1.5×avgRss), `NEAR_CAPACITY` (≥70% or freeMb < 1.5×avgRss), `SCALE_UP` (full, or sustained load15m > 0.8×vCPUs, or freeGb < 5).

**Consumers:**
1. **`scripts/host-stats.sh`** — `pnpm host:stats` (package.json script). Runs against ANY registered host via SSM (no inbound port needed from the laptop), pretty-prints the table + verdict. Also reports the app EC2's own vitals (works TODAY, before the MT5 host exists — see §10).
2. **Admin API** `GET /api/admin/mt5-hosts` → proxies `/capacity` per ACTIVE host → surfaced as a card on `/admin/engine`.
3. **Provisioning guard** — `Mt5HostService` refuses hosts not in `OK`/`NEAR_CAPACITY`-with-headroom state.

## 8. Cost model

| Phase | Infra | Capacity | $/mo | $/account |
|---|---|---|---|---|
| 1 | t3.small Windows + 50GB gp3 | 3–4 | ~$37 | ~$9–12 |
| 2 | resize → t3.large | 8–12 | ~$85 | ~$7–10 |
| 3 | N hosts from golden AMI (Terraform) | 10–12/host | ~$85/host | ~$7 |

Break-even vs MetaApi (~$30–50/acct): 1–2 accounts. Reserved pricing −~30% once stable.

## 8.5 Infrastructure-as-code home

All Spec 4 infra is defined in the **`shamarx-terraform` repo** (`/Users/shepyrd/development/shamarx/shamarx-terraform`), not ad-hoc CLI:

- New module **`modules/mt5-host`**: Windows EC2 (t3.small, SSM-only, no public IP), security group (:8100 ← app SG only), instance role (SSM core + secrets read), encrypted gp3 root, DLM nightly snapshot policy.
- `envs/prod/main.tf` gains the `mt5_host` module instantiation + `aws_secretsmanager_secret.mt5_manager_secret`.
- **Drift remediation (part of W1):** import the two resources created via CLI during Spec 3 into state — `shamarx/ctrader-oauth` secret (→ `envs/prod/main.tf` beside `broker_creds_master_key`) and the `shamarx-prod-read-ctrader-oauth` inline policy (→ `modules/compute-ec2`). `terraform plan` must come back clean before the new module applies.

## 9. Rollout

1. **W1 (~4 days):** `mt5-host` Terraform module in shamarx-terraform (SSM-only, SG-locked, EBS-encrypted, nightly snapshot) + drift imports (§8.5) · golden template · terminal-manager (provision/route/destroy/capacity) · worker · watchdog · provision the operator's own IC Markets demo via API (not UI).
2. **W2 (~3 days):** `Mt5DirectClient` + registry dispatch · `Mt5Host` table + `BrokerAccount.hostId` · `Mt5HostService` orchestration · wizard branch · admin capacity card · `scripts/host-stats.sh` finalized against the new host.
3. **Parallel-run gate (1–2 wks, passive):** operator demo on MetaApi + MT5 Direct simultaneously; compare fills, candle parity, uptime. Promotion criteria: zero unexplained fill divergence, candle parity ≥99.9%, no watchdog 3-strike alerts for 7 consecutive days.
4. **Promote:** migrate primary, demote MetaApi to fallback, open wizard branch to friends.

Rollback at any point: disable MT5_DIRECT accounts, re-enable MetaApi rows; the host is additive infrastructure.

## 10. Immediate deliverable (ships with this spec, before the plan)

`scripts/host-stats.sh` v1 targeting the **existing app EC2** — CPU/RAM/disk/swap + per-container memory + Candle-table freshness + verdict. Gives the operator the "can this box take more?" answer today and becomes the same command for mt5-host-01 once registered (`pnpm host:stats -- mt5-host-01`).

## 11. Out of scope

- mTLS between app and manager (Phase 2+, gated on LIVE friend accounts)
- Linux+Wine terminals (cost win not worth the flakiness)
- MT4 support
- Auto-scaling hosts on demand (Phase 3 keeps Terraform-manual host adds)
- Migrating the validated Dukascopy history (untouched)

## 12. Open questions for review

1. Phase 1 region: same `ap-southeast-5` as the app (lowest ops friction) vs `us-east-1`-adjacent to IC Markets NY4 (lower broker latency, cross-region VPC peering cost/complexity). **Recommendation: ap-southeast-5** — GIDEON is M15-granular; tens of ms of order latency are immaterial vs peering complexity.
2. Keep MetaApi account active during parallel-run only, or retain as paid fallback long-term? **Recommendation: retire after cTrader OAuth approval lands** (two independent rails is enough).
