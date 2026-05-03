"""Dukascopy historical data importer.

Pulls daily M1 BID candle .bi5 files from Dukascopy's public datafeed,
decompresses (LZMA), parses the binary OHLC records, resamples to the
requested timeframes (M5/M15/H1/H4/D1) using pandas, and bulk-upserts
into the Postgres Candle table.

Data feed URL pattern (verified):
  https://datafeed.dukascopy.com/datafeed/{SYMBOL}/{YEAR}/{MONTH:02d}/{DAY:02d}/BID_candles_min_1.bi5
  Note: Dukascopy uses ZERO-INDEXED months in the URL (Jan = 00, Dec = 11).

M1 candle binary record (24 bytes, big-endian):
  uint32  time-of-day in seconds (since 00:00 UTC of that file's day)
  uint32  open  (price * 10^digits)
  uint32  close (price * 10^digits)
  uint32  low   (price * 10^digits)
  uint32  high  (price * 10^digits)
  float32 volume
"""
from __future__ import annotations

import asyncio
import logging
import lzma
import struct
from datetime import datetime, timedelta
from typing import Optional

import httpx
import pandas as pd
from tqdm.asyncio import tqdm_asyncio

from db import bulk_upsert_candles, get_checkpoint, update_checkpoint

log = logging.getLogger(__name__)

DUKASCOPY_URL = (
    "https://datafeed.dukascopy.com/datafeed/"
    "{symbol}/{year}/{month:02d}/{day:02d}/BID_candles_min_1.bi5"
)

# Dukascopy price digits per symbol (price stored as int * 10^digits in .bi5 files).
SYMBOL_DIGITS: dict[str, int] = {
    "XAUUSD": 3,
    "XAGUSD": 3,
    "EURUSD": 5,
    "GBPUSD": 5,
    "USDJPY": 3,
    "USDCHF": 5,
    "AUDUSD": 5,
    "NZDUSD": 5,
    "USDCAD": 5,
    "EURJPY": 3,
    "GBPJPY": 3,
}

TF_TO_PANDAS_FREQ: dict[str, str] = {
    "M5": "5min",
    "M15": "15min",
    "H1": "1h",
    "H4": "4h",
    "D1": "1D",
}

RECORD_SIZE = 24
RECORD_FMT = ">IIIIIf"  # time_s, open, close, low, high, volume

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


async def _download_bi5(client: httpx.AsyncClient, url: str, retries: int = 6) -> bytes | None:
    """Download a .bi5 file with exponential backoff. Returns None on 404 (no data for the day)."""
    import random
    # 503 from Dukascopy means rate-limited — we wait significantly longer than network errors.
    base_delay_503 = 8.0
    base_delay_other = 1.0
    for attempt in range(retries):
        try:
            r = await client.get(url, timeout=45.0)
            if r.status_code == 404:
                return None
            if r.status_code == 503:
                if attempt == retries - 1:
                    log.warning("503 %s after %d attempts", url, retries)
                    return None
                delay = base_delay_503 * (2 ** attempt) + random.uniform(0, 3)
                await asyncio.sleep(min(delay, 60))
                continue
            r.raise_for_status()
            return r.content
        except (httpx.HTTPError, httpx.ReadTimeout) as e:
            if attempt == retries - 1:
                log.warning("Failed %s after %d attempts: %s", url, retries, e)
                return None
            delay = base_delay_other * (2 ** attempt) + random.uniform(0, 1)
            await asyncio.sleep(delay)
    return None


def _parse_bi5(data: bytes, scale: int, day_start_utc: datetime) -> list[dict]:
    """Parse one day of M1 BID candles. Returns list of dicts in chronological order."""
    if not data:
        return []
    try:
        raw = lzma.decompress(data)
    except lzma.LZMAError as e:
        log.warning("LZMA decompress failed for %s: %s", day_start_utc.date(), e)
        return []

    n = len(raw) // RECORD_SIZE
    out: list[dict] = []
    for i in range(n):
        off = i * RECORD_SIZE
        time_s, o_int, c_int, l_int, h_int, vol = struct.unpack_from(RECORD_FMT, raw, off)
        if o_int == 0:  # empty bar marker (e.g. weekend hours)
            continue
        ot = day_start_utc + timedelta(seconds=time_s)
        out.append({
            "openTime": ot,
            "open": o_int / scale,
            "high": h_int / scale,
            "low": l_int / scale,
            "close": c_int / scale,
            "volume": float(vol),
        })
    return out


async def _fetch_day(client: httpx.AsyncClient, symbol: str, day: datetime, scale: int) -> list[dict]:
    url = DUKASCOPY_URL.format(
        symbol=symbol,
        year=day.year,
        month=day.month - 1,  # 0-indexed
        day=day.day,
    )
    data = await _download_bi5(client, url)
    return _parse_bi5(data, scale, day)


def _resample(m1: list[dict], tf: str) -> list[dict]:
    """Resample M1 bars to a higher timeframe using standard OHLCV aggregation."""
    if not m1:
        return []
    df = pd.DataFrame(m1)
    df["openTime"] = pd.to_datetime(df["openTime"])
    df = df.set_index("openTime")
    freq = TF_TO_PANDAS_FREQ[tf]
    agg = df.resample(freq, label="left", closed="left").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna(subset=["open"])
    return [
        {
            "openTime": idx.to_pydatetime(),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["volume"]),
        }
        for idx, row in agg.iterrows()
    ]


async def import_symbol(
    symbol: str,
    start: datetime,
    end: datetime,
    timeframes: list[str],
    concurrency: int = 8,
    resume: bool = True,
) -> dict[str, int]:
    """Download M1 BID for [start, end], resample to `timeframes`, upsert into Candle.
    Idempotent — duplicates are skipped via ON CONFLICT.
    """
    sym = symbol.upper()
    if sym not in SYMBOL_DIGITS:
        raise ValueError(f"Unknown symbol {sym}; add to SYMBOL_DIGITS in dukascopy_importer.py")

    scale = 10 ** SYMBOL_DIGITS[sym]

    if resume:
        ckpts = {}
        for tf in timeframes:
            row = await get_checkpoint(sym, tf)
            if row and row["lastOpenTime"]:
                ckpts[tf] = row["lastOpenTime"]
        if ckpts:
            earliest = min(ckpts.values())
            if earliest > start:
                new_start = max(start, (earliest + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0))
                log.info("Resuming from %s (was %s; checkpoint lastOpenTime=%s)", new_start.date(), start.date(), earliest)
                start = new_start

    if start > end:
        log.info("Up to date — no new data to import.")
        return {tf: 0 for tf in timeframes}

    days: list[datetime] = []
    cur = start.replace(hour=0, minute=0, second=0, microsecond=0)
    end_d = end.replace(hour=0, minute=0, second=0, microsecond=0)
    while cur <= end_d:
        if cur.weekday() != 5:  # skip Saturday entirely (no FX market)
            days.append(cur)
        cur += timedelta(days=1)

    log.info("%s: downloading %d days (%s → %s)", sym, len(days), days[0].date(), days[-1].date())

    sem = asyncio.Semaphore(concurrency)
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, http2=False) as client:
        async def one(d):
            async with sem:
                return await _fetch_day(client, sym, d, scale)

        tasks = [one(d) for d in days]
        all_m1: list[dict] = []
        for coro in tqdm_asyncio.as_completed(tasks, desc=f"{sym} download", total=len(tasks)):
            bars = await coro
            if bars:
                all_m1.extend(bars)

    all_m1.sort(key=lambda b: b["openTime"])
    log.info("%s: parsed %d M1 bars", sym, len(all_m1))

    summary: dict[str, int] = {}
    for tf in timeframes:
        bars = all_m1 if tf == "M1" else _resample(all_m1, tf)
        if not bars:
            log.warning("%s %s: no bars produced — skipping", sym, tf)
            summary[tf] = 0
            continue

        log.info("%s %s: aggregated %d bars; bulk upserting...", sym, tf, len(bars))
        chunk = 5000
        inserted_total = 0
        for i in range(0, len(bars), chunk):
            batch = bars[i:i + chunk]
            rows = [
                (sym, tf, b["openTime"], b["open"], b["high"], b["low"], b["close"], b["volume"])
                for b in batch
            ]
            inserted_total += await bulk_upsert_candles(rows)

        await update_checkpoint(sym, tf, bars[-1]["openTime"], inserted_total)
        summary[tf] = inserted_total
        log.info("%s %s: +%d new rows (total %d processed)", sym, tf, inserted_total, len(bars))

    return summary


async def verify_data(symbol: str, start: datetime, end: datetime, timeframes: list[str]) -> dict:
    """Gap-detection report. Counts rows per (tf, month) and flags large gaps."""
    from db import get_pool

    sym = symbol.upper()
    pool = await get_pool()
    report: dict = {"symbol": sym, "timeframes": {}}

    expected_per_day = {"M5": 288, "M15": 96, "H1": 24, "H4": 6, "D1": 1}
    interval_minutes = {"M5": 5, "M15": 15, "H1": 60, "H4": 240, "D1": 1440}

    async with pool.acquire() as conn:
        for tf in timeframes:
            rows = await conn.fetch(
                'SELECT date_trunc(\'month\', "openTime") AS month, COUNT(*) AS c '
                'FROM "Candle" WHERE symbol=$1 AND timeframe=$2 AND "openTime" >= $3 AND "openTime" <= $4 '
                'GROUP BY 1 ORDER BY 1',
                sym, tf, start, end,
            )
            month_counts = {r["month"].strftime("%Y-%m"): r["c"] for r in rows}

            # Gap detection
            gap_rows = await conn.fetch(
                'SELECT "openTime", '
                'EXTRACT(EPOCH FROM ("openTime" - LAG("openTime") OVER (ORDER BY "openTime"))) / 60 AS gap_min '
                'FROM "Candle" WHERE symbol=$1 AND timeframe=$2 AND "openTime" >= $3 AND "openTime" <= $4 '
                'ORDER BY "openTime"',
                sym, tf, start, end,
            )
            interval = interval_minutes[tf]
            big_gaps = []
            for r in gap_rows:
                if r["gap_min"] is None:
                    continue
                # Allowed: weekend close ~Fri 21:00 UTC → Sun 22:00 UTC = ~49h.
                # Anything > 2× expected interval AND not a weekend window is suspicious.
                if r["gap_min"] > interval * 2:
                    dow = r["openTime"].weekday()
                    is_weekend = dow == 6 and r["gap_min"] < 60 * 49 + 60  # Sunday open from prior Friday close
                    if not is_weekend:
                        big_gaps.append((r["openTime"].isoformat(), int(r["gap_min"])))
            report["timeframes"][tf] = {
                "total_rows": sum(month_counts.values()),
                "by_month": month_counts,
                "anomalous_gaps": big_gaps[:20],
                "anomalous_gap_count": len(big_gaps),
            }

    return report
