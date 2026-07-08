# GIDEON v1.1 — Retrace Entries

**Released:** 2026-07-09 (app `a19403b`, web `2345341`) · **Status:** live, default ON · **Kill-switch:** `RETRACE_ENTRY=false`

---

## In one sentence

Instead of buying the close of the rejection bar (chasing the snap-back), GIDEON now parks a **limit order half-way back into the sweep zone** and lets the market's habitual retest deliver a better price — cutting effective risk per trade in half and roughly doubling every outcome measured in R.

---

## Why

The June live review showed the strategy's structure targets 3.5R runners, but entries at the M15 close pay the **worst price of the setup** — the top of the rejection. SMC practice ("wait for the retest, enter in the discount zone") and our own decision-log data both pointed the same way. Two exit-side experiments (later break-even, wider trail) were A/B-tested first and **rejected** — the trail was already near-optimal. Entry price was the last untested lever, and the largest.

## Mechanics

| Aspect | Before (v1.0) | Now (v1.1) |
|---|---|---|
| Entry | MARKET at M15 close | LIMIT at `entry − 0.5 × (entry − SL)` (BUY; mirrored for SELL) |
| Risk per lot | full sweep distance | **half** — stop unchanged, entry closer |
| Lot size | equity × preset% ÷ full distance | same dollar risk → **lots × 2** |
| Protection | relative SL/TP + post-fill amend | absolute SL/TP **on the order** — protected from the first tick |
| If price never retraces | trade taken at close | order **expires after 12 M15 bars (3 h)** — no trade, no risk |
| Brokers | all | cTrader (native GTD limits); others fall back to MARKET |

A parked limit still consumes the pending setup (no signal re-fire spam). Trade rows are born `PENDING` and promoted to `OPEN` at the **real fill price** by a 1-minute monitor, or finalized `CANCELLED / EXPIRED` with PnL `NULL` — an unfilled order never risked anything. Session analytics count real fills only.

## Evidence (replay = the live evaluator, Jan 5 – Jul 8 2026, $1k @ 1.5%)

Simulator deliberately **pessimistic**: a bar sweeping through both limit and stop counts as a same-bar loss; the fill bar contributes no take-profit and no trail progress (the first, unhardened run showed PF 4.07 — hardening exposed ~40% of that as look-ahead and it was removed before judging).

| | Trades | Win rate | Net | PF | Max DD | Losing months |
|---|---|---|---|---|---|---|
| v1.0 baseline | 182 | 54.4% | +$290.59 | 1.42 | $101.79 | 2 |
| R25 (25%, 6 bars) | 160 | 54.4% | +$388.20 | 1.68 | $89.79 | 0 |
| R50 (50%, 6 bars) | 152 | 54.6% | +$708.39 | 2.26 | $111.24 | 0 |
| **R50-LONG (50%, 12 bars) → shipped** | 156 | 56.4% | **+$944.18** | **2.63** | $93.12 | **0** |

Known caveats, stated up front: single 6-month window (no older candle data exists); gains concentrated in June the way baseline's were concentrated in January — the two configurations favor different market regimes (baseline catches runaway months whose winners never retrace; retrace harvests retest-heavy months); sim fills at exact touch.

## What changes visibly

- After a signal fires, the feed shows **"retrace limit parked @ … waiting for pullback"**, then either **FILLED** or **"expired unfilled — setup left without us"**. Expiries are the design working, not a malfunction.
- Trades tables show **WAITING FILL** (amber) and **CANCELLED** (struck) states.
- Small accounts qualify for **more** signals than before: half the per-lot risk means the broker-minimum-lot gate clears at roughly half the equity it used to need.

## Judgement criteria

Replay says ~2× profit factor. Judge live on **a month of fills**, not the first trade: track fill-rate (sim says ~75–85% of setups fill within 12 bars), realized entry vs limit price (slippage), and live-vs-replay parity via the decision log.

## Rollback

`RETRACE_ENTRY=false` in the host `.env` + `docker compose up -d --force-recreate trading-bot` → v1.0 market entries, same brain, no data migration needed. Already-parked limits expire harmlessly at the broker.
