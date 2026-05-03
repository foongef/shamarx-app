"""Async Postgres pool + bulk-upsert helpers shared by importer and historical_data."""
import os
from typing import Optional

import asyncpg

_pool: Optional[asyncpg.Pool] = None


def _normalize_db_url(url: str) -> str:
    """Strip Prisma-only query params asyncpg doesn't accept (e.g. ?schema=public)."""
    if "?" in url:
        url = url.split("?", 1)[0]
    return url


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        url = _normalize_db_url(os.environ["DATABASE_URL"])
        _pool = await asyncpg.create_pool(url, min_size=1, max_size=10, command_timeout=60)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def bulk_upsert_candles(rows: list[tuple]) -> int:
    """rows: [(symbol, timeframe, openTime_dt, open, high, low, close, volume), ...]
    Returns number actually inserted (skipDuplicates via ON CONFLICT)."""
    if not rows:
        return 0
    pool = await get_pool()
    symbols = [r[0] for r in rows]
    tfs = [r[1] for r in rows]
    open_times = [r[2] for r in rows]
    opens = [r[3] for r in rows]
    highs = [r[4] for r in rows]
    lows = [r[5] for r in rows]
    closes = [r[6] for r in rows]
    volumes = [r[7] for r in rows]
    async with pool.acquire() as conn:
        result: str = await conn.execute(
            """INSERT INTO "Candle" (id, symbol, timeframe, "openTime", open, high, low, close, volume, "createdAt")
               SELECT gen_random_uuid()::text, s, tf, ot, o, h, l, c, v, NOW()
               FROM UNNEST(
                 $1::text[], $2::text[], $3::timestamp[],
                 $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[]
               ) AS t(s, tf, ot, o, h, l, c, v)
               ON CONFLICT (symbol, timeframe, "openTime") DO NOTHING""",
            symbols, tfs, open_times, opens, highs, lows, closes, volumes,
        )
    # asyncpg returns "INSERT 0 N"
    try:
        return int(result.split()[-1])
    except (ValueError, IndexError):
        return 0


async def get_checkpoint(symbol: str, timeframe: str, source: str = "dukascopy"):
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            'SELECT "lastOpenTime", "rowsImported" FROM "ImportCheckpoint" '
            "WHERE symbol=$1 AND timeframe=$2 AND source=$3",
            symbol, timeframe, source,
        )


async def update_checkpoint(
    symbol: str, timeframe: str, last_time, rows_added: int, source: str = "dukascopy"
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO "ImportCheckpoint" (id, symbol, timeframe, source, "lastOpenTime", "rowsImported", "updatedAt")
               VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, NOW())
               ON CONFLICT (symbol, timeframe, source) DO UPDATE
                 SET "lastOpenTime" = GREATEST("ImportCheckpoint"."lastOpenTime", EXCLUDED."lastOpenTime"),
                     "rowsImported" = "ImportCheckpoint"."rowsImported" + $5,
                     "updatedAt" = NOW()""",
            symbol, timeframe, source, last_time, rows_added,
        )


async def fetch_candles_db(
    symbol: str, timeframe: str, start, end
) -> list[dict]:
    """Read candles from DB filtered by (symbol, timeframe, openTime range), ordered by openTime."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            'SELECT symbol, timeframe, "openTime", open, high, low, close, volume '
            'FROM "Candle" WHERE symbol=$1 AND timeframe=$2 '
            'AND "openTime" >= $3 AND "openTime" <= $4 '
            'ORDER BY "openTime" ASC',
            symbol, timeframe, start, end,
        )
    return [
        {
            "symbol": r["symbol"],
            "timeframe": r["timeframe"],
            "openTime": r["openTime"].isoformat(),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["volume"]),
        }
        for r in rows
    ]
