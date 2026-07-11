# GIDEON v1.2 — Setup-Quality Gate

**Released:** 2026-07-12 · **Change:** `maxSlSweepRatio: 0.5` on all 4 pairs · **Rollback:** delete 4 config lines

## In one sentence

The same strategy, refusing its historically bad trades: entries fire only when the structural stop is tight relative to the sweep candle — a conviction sweep entered near the defended level — and the loose, far-from-structure chases that bled on every pair in every era are skipped.

## The rule

At entry time: `slDistance / sweepCandleRange > 0.5` → skip the bar, **keep the setup pending**. If price returns toward the level the ratio shrinks and the setup qualifies — an emergent retest entry.

## Evidence

Discovery: 10-year setup-level analysis, pre-registered (design 2015–23, one-shot validation 2023–25). Tight subset +$2,190 across every regime era; loose subset −$3,500. Survives mode-confound (tight beats loose within both REVERSAL and CONTINUATION); 4 of 5 two-year chunks positive; EURUSD flips from "structural loser" to +$5.69/setup.

True replays (all 4 pairs, $1k @ 1.5%):

| Window | Baseline | Gated |
|---|---|---|
| 2024–26 | +$660 · PF 1.18 · DD $243 | +$661 · PF 1.27 · DD $301 |
| 2022–24 | +$6 · PF 1.00 · DD $479 | **+$855 · PF 1.30 · DD $211** |
| 2025–26 (last 12mo) | +$76 · PF 1.04 | **+$667 · PF 1.51 · DD $202** |

Non-overlapping 4-year total: **+$1,516 vs +$666 (2.3×)**. First and only candidate of the ~25-experiment campaign to pass all three windows. Unlike every rejected mirage, the true replay came in at-or-above the post-hoc estimate (the skip-bar semantics finds retest entries the spreadsheet filter couldn't see).

## What changes visibly

~30–40% fewer trades (quiet days are the filter working); win rate ~2pts lower, winners bigger; pair leadership rotates (keep all four — the aggregate was positive in every window). Known blemish: 2024–26 drawdown $301 vs $243 — the circuit breaker (v1.1.1+) backstops the tail.

## Sessions

`a76ae279` (24–26) · `283c9f6d` (22–24) · `fdb63d63` (last12) — labeled `quality-gate 0.5 · *` in Replay History.
