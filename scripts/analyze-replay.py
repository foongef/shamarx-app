#!/usr/bin/env python3
"""
Generate a per-pair × per-month markdown analysis from a live-replay JSON
output (produced by `run-live-replay.ts --output <file>`).

Usage:
  python3 scripts/analyze-replay.py /tmp/replay.json > docs/replay-analysis.md
"""
from __future__ import annotations
import json
import sys
from collections import defaultdict
from datetime import datetime
from typing import Any


def fmt_money(x: float) -> str:
    sign = "+" if x >= 0 else "-"
    return f"{sign}${abs(x):,.2f}"


def fmt_pct(x: float) -> str:
    sign = "+" if x >= 0 else "-"
    return f"{sign}{abs(x):.2f}%"


def aggregate(trades: list[dict[str, Any]]):
    """Bucket trades by (symbol, year, month) and compute per-bucket stats."""
    by_pair: dict[str, list[dict]] = defaultdict(list)
    by_pair_year: dict[tuple[str, int], list[dict]] = defaultdict(list)
    by_pair_month: dict[tuple[str, int, int], list[dict]] = defaultdict(list)
    for t in trades:
        sym = t["symbol"]
        opened = datetime.fromisoformat(t["openedAt"].replace("Z", "+00:00"))
        by_pair[sym].append(t)
        by_pair_year[(sym, opened.year)].append(t)
        by_pair_month[(sym, opened.year, opened.month)].append(t)
    return by_pair, by_pair_year, by_pair_month


def stats(rows: list[dict]) -> dict:
    pnls = [r.get("pnl") or 0 for r in rows]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    total = sum(pnls)
    gross_w = sum(wins)
    gross_l = -sum(losses)
    pf = (gross_w / gross_l) if gross_l > 0 else float("inf") if gross_w > 0 else 0.0
    return {
        "trades": len(rows),
        "wins": len(wins),
        "losses": len(losses),
        "wr": (100 * len(wins) / len(rows)) if rows else 0.0,
        "pnl": total,
        "avg_win": (sum(wins) / len(wins)) if wins else 0.0,
        "avg_loss": (sum(losses) / len(losses)) if losses else 0.0,
        "pf": pf,
        "best": max(pnls) if pnls else 0.0,
        "worst": min(pnls) if pnls else 0.0,
    }


def render(file_path: str) -> str:
    with open(file_path) as f:
        data = json.load(f)
    trades = data.get("trades", [])
    summary = data.get("metrics", {})
    by_pair, by_pair_year, by_pair_month = aggregate(trades)

    out: list[str] = []
    out.append("# Live-Replay Performance Analysis")
    out.append("")
    out.append(f"**Range:** {data.get('range','?')}  ")
    out.append(f"**Initial balance:** ${data.get('balance',0):,.0f}  ")
    out.append(f"**Risk per trade:** {data.get('risk',0)}%  ")
    out.append(f"**Pairs:** {', '.join(data.get('pairs', []))}  ")
    out.append(f"**Strategy:** V6-alt SMC orchestrator (live-equivalent)  ")
    out.append("")
    out.append("## Headline")
    out.append("")
    out.append(f"- **Total trades:** {summary.get('tradesCount', 0):,}  ")
    out.append(f"- **Wins / Losses:** {summary.get('winsCount',0)} / {summary.get('lossesCount',0)}  ")
    wr = (100 * summary.get("winsCount", 0) / summary["tradesCount"]) if summary.get("tradesCount") else 0
    out.append(f"- **Win rate:** {wr:.1f}%  ")
    out.append(f"- **Realized PnL:** {fmt_money(summary.get('realizedPnl', 0))}  ")
    out.append(f"- **Net return:** {fmt_pct(summary.get('netReturnPct', 0))}  ")
    out.append(f"- **Final balance:** ${data.get('finalBalance',0):,.2f}  ")
    out.append(f"- **Max concurrent positions:** {data.get('maxConcurrent','?')}  ")
    out.append("")

    # ─── Per-pair summary ─────────────────────────────────────────────────
    out.append("## Per-Pair Summary (whole window)")
    out.append("")
    out.append("| Pair | Trades | W | L | WR | PnL | Avg Win | Avg Loss | PF | Best | Worst |")
    out.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for sym in sorted(by_pair):
        s = stats(by_pair[sym])
        pf = "∞" if s["pf"] == float("inf") else f"{s['pf']:.2f}"
        out.append(
            f"| {sym} | {s['trades']} | {s['wins']} | {s['losses']} | "
            f"{s['wr']:.1f}% | {fmt_money(s['pnl'])} | "
            f"{fmt_money(s['avg_win'])} | {fmt_money(s['avg_loss'])} | {pf} | "
            f"{fmt_money(s['best'])} | {fmt_money(s['worst'])} |"
        )
    out.append("")

    # ─── Per-year ─────────────────────────────────────────────────────────
    years = sorted({y for (_, y) in by_pair_year.keys()})
    pairs = sorted(by_pair.keys())
    out.append("## Per-Year × Per-Pair PnL")
    out.append("")
    out.append("| Year | " + " | ".join(pairs) + " | **Year Total** |")
    out.append("|---|" + "---:|" * len(pairs) + "---:|")
    for y in years:
        cells = []
        year_total = 0.0
        for p in pairs:
            rows = by_pair_year.get((p, y), [])
            s = stats(rows)
            year_total += s["pnl"]
            if s["trades"] > 0:
                cells.append(f"{fmt_money(s['pnl'])} ({s['trades']}t, {s['wr']:.0f}% WR)")
            else:
                cells.append("—")
        out.append(f"| {y} | " + " | ".join(cells) + f" | **{fmt_money(year_total)}** |")
    out.append("")

    # ─── Per-month ────────────────────────────────────────────────────────
    out.append("## Per-Month × Per-Pair PnL")
    out.append("")
    out.append("| Month | " + " | ".join(pairs) + " | **Month Total** | Trades |")
    out.append("|---|" + "---:|" * len(pairs) + "---:|---:|")
    months = sorted({(y, m) for (_, y, m) in by_pair_month.keys()})
    for y, m in months:
        cells = []
        month_total = 0.0
        month_trades = 0
        for p in pairs:
            rows = by_pair_month.get((p, y, m), [])
            s = stats(rows)
            month_total += s["pnl"]
            month_trades += s["trades"]
            if s["trades"] > 0:
                cells.append(f"{fmt_money(s['pnl'])} ({s['trades']}t)")
            else:
                cells.append("—")
        ymonth = f"{y}-{m:02d}"
        out.append(f"| {ymonth} | " + " | ".join(cells) + f" | **{fmt_money(month_total)}** | {month_trades} |")
    out.append("")

    # ─── Equity-curve checkpoints ────────────────────────────────────────
    if trades:
        out.append("## Equity Curve (running balance after each trade)")
        out.append("")
        # Sample at most 20 checkpoints for readability
        sorted_trades = sorted(trades, key=lambda t: t["closedAt"])
        balance = data.get("balance", 0)
        n = len(sorted_trades)
        step = max(1, n // 20)
        out.append("| After trade # | Date | Symbol | Balance | Drawdown vs peak |")
        out.append("|---:|---|---|---:|---:|")
        peak = balance
        for i, t in enumerate(sorted_trades):
            balance += t.get("pnl") or 0
            peak = max(peak, balance)
            if i % step == 0 or i == n - 1:
                dd = (balance - peak) / peak * 100 if peak > 0 else 0
                date_str = t["closedAt"][:10]
                out.append(
                    f"| {i+1} | {date_str} | {t['symbol']} | "
                    f"${balance:,.2f} | {fmt_pct(dd)} |"
                )
        out.append("")

    # ─── Exit-reason breakdown ────────────────────────────────────────────
    out.append("## Exit-Reason Breakdown by Pair")
    out.append("")
    out.append("| Pair | SL | TP | FORCED_CLOSE |")
    out.append("|---|---:|---:|---:|")
    for sym in pairs:
        from collections import Counter
        cnt = Counter(t.get("exitReason") for t in by_pair[sym])
        out.append(
            f"| {sym} | {cnt.get('SL', 0)} | {cnt.get('TP', 0)} | "
            f"{cnt.get('FORCED_CLOSE', 0)} |"
        )
    out.append("")

    return "\n".join(out)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: analyze-replay.py <replay.json>", file=sys.stderr)
        sys.exit(1)
    print(render(sys.argv[1]))
