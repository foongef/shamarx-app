"""Historical candle data endpoint for backtesting.

Source priority (per request):
  1. Postgres `Candle` table (populated by `pnpm data:import` from Dukascopy)
  2. MetaAPI (when MT5_MODE=metaapi)
  3. CSV fallback (`data/{symbol}_{tf}.csv`)
"""

import os
import csv
import logging
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, HTTPException
from models import CandleData
from db import fetch_candles_db

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


@historical_router.get("", response_model=list[CandleData])
async def get_historical_candles(
    symbol: str = Query(default="XAUUSD"),
    timeframe: str = Query(default="M15"),
    start: Optional[str] = Query(default=None, description="Start date ISO format (e.g. 2025-01-01)"),
    end: Optional[str] = Query(default=None, description="End date ISO format (e.g. 2025-01-31)"),
):
    """Return historical candles. Priority: Postgres → MetaAPI → CSV."""
    start_dt = _normalize_dt(start, datetime(2023, 1, 1))
    end_dt = _normalize_dt(end, datetime.now(timezone.utc).replace(tzinfo=None), end_of_day=True)

    # 1) Postgres (preferred — Dukascopy-imported data)
    try:
        db_rows = await fetch_candles_db(symbol.upper(), timeframe.upper(), start_dt, end_dt)
        if db_rows:
            logger.info(f"DB hit: {symbol} {timeframe} {len(db_rows)} rows")
            return db_rows
    except Exception as e:
        logger.warning(f"DB read failed (will fall back): {e}")

    # 2) MetaAPI (if explicitly configured)
    mode = os.getenv("MT5_MODE", "mock")
    if mode == "metaapi":
        try:
            return await _fetch_metaapi_candles(symbol, timeframe, start, end)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"MetaAPI error for {symbol} {timeframe}: {e}\n{traceback.format_exc()}")
            # Fall through to CSV instead of erroring out

    # 3) CSV fallback
    rows = _load_csv(symbol, timeframe)
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No historical data for {symbol} {timeframe} in DB / MetaAPI / CSV",
        )

    filtered = [
        r for r in rows
        if datetime.fromisoformat(r["openTime"]) >= start_dt
        and datetime.fromisoformat(r["openTime"]) <= end_dt
    ]
    return filtered
