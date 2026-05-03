"""CLI entry point for historical data import.

Usage:
    python -m import_cli xauusd --from 2023-01-01 --to 2026-04-30 --tf m5,m15,h1,h4,d1
    python -m import_cli xauusd --verify-only --from 2023-01-01 --to 2026-04-30
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

# Ensure relative imports work when invoked as `python import_cli.py`
sys.path.insert(0, str(Path(__file__).parent))

from db import close_pool  # noqa: E402
from dukascopy_importer import import_symbol, verify_data  # noqa: E402


def _parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


def _parse_tfs(s: str) -> list[str]:
    return [t.strip().upper() for t in s.split(",") if t.strip()]


async def _amain() -> int:
    parser = argparse.ArgumentParser(prog="data-import")
    parser.add_argument("symbol", help="Symbol e.g. XAUUSD")
    parser.add_argument("--from", dest="start", type=_parse_date, required=True, metavar="YYYY-MM-DD")
    parser.add_argument("--to", dest="end", type=_parse_date, required=True, metavar="YYYY-MM-DD")
    parser.add_argument("--tf", dest="timeframes", type=_parse_tfs, default=["M5", "M15", "H1", "H4", "D1"])
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--no-resume", action="store_true", help="Ignore checkpoint, redownload full range")
    parser.add_argument("--verify-only", action="store_true", help="Skip download, run gap-detection report")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    sym = args.symbol.upper()

    try:
        if args.verify_only:
            report = await verify_data(sym, args.start, args.end, args.timeframes)
            print(json.dumps(report, indent=2, default=str))
            anom = sum(t.get("anomalous_gap_count", 0) for t in report["timeframes"].values())
            return 0 if anom == 0 else 2

        summary = await import_symbol(
            sym, args.start, args.end, args.timeframes,
            concurrency=args.concurrency, resume=not args.no_resume,
        )

        print("\n=== Import summary ===")
        for tf, n in summary.items():
            print(f"  {tf}: +{n} new rows")
        return 0
    finally:
        await close_pool()


def main() -> int:
    try:
        return asyncio.run(_amain())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
