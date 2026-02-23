"""Historical candle data endpoint for backtesting.

Supports two data sources:
- MT5_MODE=mock: loads from CSV files in data/ directory
- MT5_MODE=metaapi: fetches real data from MetaAPI (Pepperstone MT5)
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


@historical_router.get("", response_model=list[CandleData])
async def get_historical_candles(
    symbol: str = Query(default="XAUUSD"),
    timeframe: str = Query(default="M15"),
    start: Optional[str] = Query(default=None, description="Start date ISO format (e.g. 2025-01-01)"),
    end: Optional[str] = Query(default=None, description="End date ISO format (e.g. 2025-01-31)"),
):
    """Return historical candles filtered by date range.

    Uses MetaAPI for real data when MT5_MODE=metaapi, otherwise falls back to CSV files.
    """
    mode = os.getenv("MT5_MODE", "mock")

    if mode == "metaapi":
        try:
            return await _fetch_metaapi_candles(symbol, timeframe, start, end)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"MetaAPI error for {symbol} {timeframe}: {e}\n{traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=f"MetaAPI error: {str(e)}")

    # CSV fallback
    rows = _load_csv(symbol, timeframe)
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No historical data for {symbol} {timeframe}",
        )

    filtered = rows

    if start:
        start_dt = datetime.fromisoformat(start)
        filtered = [r for r in filtered if datetime.fromisoformat(r["openTime"]) >= start_dt]

    if end:
        end_dt = datetime.fromisoformat(end)
        if len(end) == 10:
            end_dt = end_dt.replace(hour=23, minute=59, second=59)
        filtered = [r for r in filtered if datetime.fromisoformat(r["openTime"]) <= end_dt]

    return filtered
