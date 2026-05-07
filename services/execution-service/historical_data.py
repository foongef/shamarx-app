"""Historical candle data endpoint for backtesting.

Source priority (per request):
  1. Postgres `Candle` table (populated by `pnpm data:import` from Dukascopy)
  2. MetaAPI gap-fill — if DB doesn't cover the full requested range
     (i.e. the latest DB candle is older than the requested end), pull
     the missing tail from MetaApi and merge.
  3. CSV fallback (`data/{symbol}_{tf}.csv`) for offline development.
"""

import os
import csv
import logging
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, HTTPException
from models import CandleData
from db import fetch_candles_db, bulk_upsert_candles

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent / "data"

historical_router = APIRouter()

# In-memory cache: (symbol, timeframe) -> list of CandleData dicts
_cache: dict[tuple[str, str], list[dict]] = {}


def _load_csv(symbol: str, timeframe: str) -> list[dict]:
    """Load CSV file into memory, caching the result."""
    key = (symbol.upper(), timeframe.upper())
    if key in _cache:
        return _cache[key]

    filename = f"{symbol.lower()}_{timeframe.lower()}.csv"
    filepath = DATA_DIR / filename
    if not filepath.exists():
        return []

    rows = []
    with open(filepath, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                "symbol": row["symbol"],
                "timeframe": row["timeframe"],
                "openTime": row["openTime"],
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            })

    rows.sort(key=lambda r: r["openTime"])
    _cache[key] = rows
    return rows


def _preload():
    """Preload available CSV data at startup."""
    if not DATA_DIR.exists():
        return
    for csv_file in DATA_DIR.glob("*.csv"):
        parts = csv_file.stem.split("_")
        if len(parts) == 2:
            symbol = parts[0].upper()
            timeframe = parts[1].upper()
            _load_csv(symbol, timeframe)


_preload()


async def _fetch_metaapi_candles(
    symbol: str, timeframe: str, start: Optional[str], end: Optional[str]
) -> list[CandleData]:
    """Fetch historical candles from MetaAPI."""
    from metaapi_mt5 import metaapi_mt5

    start_dt = datetime.fromisoformat(start) if start else datetime(2025, 1, 1)
    end_dt = datetime.fromisoformat(end) if end else datetime.now(timezone.utc).replace(tzinfo=None)

    # If date only, expand end to end of day
    if end and len(end) == 10:
        end_dt = end_dt.replace(hour=23, minute=59, second=59)

    return await metaapi_mt5.get_historical_candles(
        symbol, timeframe, start_dt, end_dt
    )


def _normalize_dt(s: Optional[str], default_dt: datetime, end_of_day: bool = False) -> datetime:
    if not s:
        return default_dt
    dt = datetime.fromisoformat(s)
    if end_of_day and len(s) == 10:
        dt = dt.replace(hour=23, minute=59, second=59)
    return dt


_TIMEFRAME_MS = {
    "M1": 60_000,
    "M5": 5 * 60_000,
    "M15": 15 * 60_000,
    "H1": 60 * 60_000,
    "H4": 4 * 60 * 60_000,
    "D1": 24 * 60 * 60_000,
}


def _resolve_mode() -> str:
    """Read mode from Redis runtime override → env var → default 'mock'.
    Mirrors routes.get_mode() so historical-candles honors the same toggle."""
    try:
        from routes import _get_redis  # type: ignore
        r = _get_redis()
        if r:
            override = r.get("live:engine:mode")
            if override and override in ("mock", "metaapi"):
                return override
    except Exception:
        pass
    return os.getenv("MT5_MODE", "mock")


def _to_naive_iso(s) -> Optional[str]:
    """Coerce DB datetime / ISO string to a naive ISO for comparison."""
    if isinstance(s, datetime):
        return s.replace(tzinfo=None).isoformat()
    if isinstance(s, str):
        return s
    return None


@historical_router.get("", response_model=list[CandleData])
async def get_historical_candles(
    symbol: str = Query(default="XAUUSD"),
    timeframe: str = Query(default="M15"),
    start: Optional[str] = Query(default=None, description="Start date ISO format (e.g. 2025-01-01)"),
    end: Optional[str] = Query(default=None, description="End date ISO format (e.g. 2025-01-31)"),
):
    """Return historical candles. DB first, then MetaApi gap-fill if incomplete."""
    start_dt = _normalize_dt(start, datetime(2023, 1, 1))
    end_dt = _normalize_dt(end, datetime.now(timezone.utc).replace(tzinfo=None), end_of_day=True)

    tf_upper = timeframe.upper()
    sym_upper = symbol.upper()
    tf_ms = _TIMEFRAME_MS.get(tf_upper, 0)

    # 1) Postgres
    db_rows: list = []
    try:
        db_rows = await fetch_candles_db(sym_upper, tf_upper, start_dt, end_dt) or []
    except Exception as e:
        logger.warning(f"DB read failed (will fall back): {e}")

    def _get_open_time(row):
        """Robust openTime extractor — works for dicts and Pydantic objects.
        Pydantic CandleData uses `open_time` as the Python attr (alias `openTime`)."""
        if isinstance(row, dict):
            return row.get("openTime") or row.get("open_time")
        # Pydantic v2 attribute name (snake_case)
        if hasattr(row, "open_time"):
            return getattr(row, "open_time")
        # Fallback to alias-based attribute
        if hasattr(row, "openTime"):
            return getattr(row, "openTime")
        try:
            d = row.model_dump(by_alias=True)
            return d.get("openTime") or d.get("open_time")
        except Exception:
            return None

    # 2) Decide if DB coverage is sufficient. We approximate the expected
    # candle count for the range and check if DB has at least 80% of it.
    # If not (or DB is empty), refetch the FULL range from MetaApi — handles
    # both "head gap" (cron started mid-range) and "tail gap" (request extends
    # past last cron poll) in one shot.
    expected_count = 0
    if tf_ms > 0:
        range_ms = (end_dt - start_dt).total_seconds() * 1000
        # Forex weekends: roughly 5/7 of bars present
        expected_count = int((range_ms / tf_ms) * (5 / 7))

    coverage = (len(db_rows) / expected_count) if expected_count > 0 else 1.0
    sufficient = coverage >= 0.80

    mode = _resolve_mode()

    if not sufficient and mode == "metaapi":
        logger.info(
            f"DB coverage {len(db_rows)}/{expected_count} ({coverage:.0%}) — fetching full range from MetaApi"
        )
        try:
            metaapi_rows = await _fetch_metaapi_candles(
                symbol,
                timeframe,
                start_dt.isoformat(),
                end_dt.isoformat(),
            )
            # Merge with DB — DB takes precedence for overlapping openTimes
            seen_keys = set()
            merged: list = []
            for r in db_rows:
                key = _to_naive_iso(_get_open_time(r))
                if key and key not in seen_keys:
                    merged.append(r)
                    seen_keys.add(key)
            for r in metaapi_rows:
                key = _to_naive_iso(_get_open_time(r))
                if key and key not in seen_keys:
                    merged.append(r)
                    seen_keys.add(key)
            # Sort chronologically by openTime
            merged.sort(key=lambda r: _to_naive_iso(_get_open_time(r)) or "")
            logger.info(
                f"Merged DB + MetaApi: {len(merged)} total rows for {symbol} {timeframe} "
                f"({len(db_rows)} from DB + {len(metaapi_rows)} from MetaApi, deduped)"
            )
            # Write-through cache: persist NEW MetaApi rows back to the
            # Candle table so subsequent requests for overlapping ranges
            # hit the DB fast path. Idempotent via the unique constraint.
            db_keys = {_to_naive_iso(_get_open_time(r)) for r in db_rows}
            new_rows: list[tuple] = []
            for r in metaapi_rows:
                key = _to_naive_iso(_get_open_time(r))
                if key is None or key in db_keys:
                    continue
                # Coerce to (symbol, timeframe, openTime_dt, open, high, low, close, volume)
                if hasattr(r, "model_dump"):
                    d = r.model_dump(by_alias=True)
                elif isinstance(r, dict):
                    d = r
                else:
                    continue
                ot = d.get("openTime") or d.get("open_time")
                ot_dt = ot if isinstance(ot, datetime) else datetime.fromisoformat(_to_naive_iso(ot))
                new_rows.append((
                    sym_upper, tf_upper, ot_dt,
                    float(d["open"]), float(d["high"]), float(d["low"]),
                    float(d["close"]), float(d.get("volume", 0)),
                ))
            if new_rows:
                try:
                    inserted = await bulk_upsert_candles(new_rows)
                    logger.info(
                        f"Cached {inserted} new {symbol} {timeframe} candles to DB "
                        f"(of {len(new_rows)} attempted)"
                    )
                except Exception as e:
                    # Non-fatal — caller still gets the merged result, we just
                    # don't accelerate future requests this time.
                    logger.warning(f"Cache write-through failed (non-fatal): {e}")
            db_rows = merged
        except Exception as e:
            logger.error(f"MetaApi gap-fill failed for {symbol} {timeframe}: {e}\n{traceback.format_exc()}")

    if db_rows:
        return db_rows

    # 3) CSV fallback (offline dev mode)
    rows = _load_csv(symbol, timeframe)
    if rows:
        filtered = [
            r for r in rows
            if datetime.fromisoformat(r["openTime"]) >= start_dt
            and datetime.fromisoformat(r["openTime"]) <= end_dt
        ]
        if filtered:
            return filtered

    raise HTTPException(
        status_code=404,
        detail=f"No historical data for {symbol} {timeframe} in DB / MetaAPI / CSV "
               f"for range {start_dt.date()} → {end_dt.date()}",
    )
