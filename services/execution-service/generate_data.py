"""Generate synthetic XAUUSD M15 and H1 candle data for backtesting."""

import csv
import random
import math
from datetime import datetime, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"


def generate_candles(
    timeframe_minutes: int,
    start: datetime,
    end: datetime,
    initial_price: float = 2650.0,
) -> list[dict]:
    """Generate realistic XAUUSD candles using a trending random walk."""
    candles = []
    price = initial_price
    trend = 0.0  # Current trend component
    volatility = 3.0 if timeframe_minutes == 15 else 8.0  # ATR-like base volatility

    current = start
    while current < end:
        # Skip weekends (Sat=5, Sun=6)
        if current.weekday() >= 5:
            current += timedelta(minutes=timeframe_minutes)
            continue

        # Skip outside trading hours (approx forex hours: Sun 17:00 - Fri 17:00 ET)
        hour = current.hour
        if hour < 1 or hour > 23:  # Simplified: skip midnight hour
            current += timedelta(minutes=timeframe_minutes)
            continue

        # Trend regime changes every ~2 days
        if random.random() < 0.005:
            trend = random.uniform(-0.3, 0.3)

        # Mean reversion toward 2650 center
        reversion = (2650.0 - price) * 0.0002

        # Generate OHLC
        open_price = price
        move = trend + reversion + random.gauss(0, volatility)

        # Intra-candle high/low
        body = abs(move)
        upper_wick = random.uniform(0, volatility * 0.7)
        lower_wick = random.uniform(0, volatility * 0.7)

        if move >= 0:
            close_price = open_price + move
            high_price = close_price + upper_wick
            low_price = open_price - lower_wick
        else:
            close_price = open_price + move
            high_price = open_price + upper_wick
            low_price = close_price - lower_wick

        # Ensure OHLC consistency
        high_price = max(high_price, open_price, close_price)
        low_price = min(low_price, open_price, close_price)

        volume = random.uniform(500, 3000)

        candles.append({
            "symbol": "XAUUSD",
            "timeframe": f"M{timeframe_minutes}" if timeframe_minutes < 60 else f"H{timeframe_minutes // 60}",
            "openTime": current.isoformat(),
            "open": round(open_price, 2),
            "high": round(high_price, 2),
            "low": round(low_price, 2),
            "close": round(close_price, 2),
            "volume": round(volume, 2),
        })

        price = close_price
        current += timedelta(minutes=timeframe_minutes)

    return candles


def write_csv(candles: list[dict], filepath: Path):
    if not candles:
        return
    with open(filepath, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=candles[0].keys())
        writer.writeheader()
        writer.writerows(candles)
    print(f"Wrote {len(candles)} candles to {filepath}")


def main():
    random.seed(42)  # Reproducible data
    DATA_DIR.mkdir(exist_ok=True)

    start = datetime(2025, 1, 1, 0, 0)
    end = datetime(2025, 7, 1, 0, 0)

    # Generate M15 candles
    m15_candles = generate_candles(15, start, end, initial_price=2650.0)
    write_csv(m15_candles, DATA_DIR / "xauusd_m15.csv")

    # Generate H1 candles from same price series for consistency
    random.seed(42)
    h1_candles = generate_candles(60, start, end, initial_price=2650.0)
    write_csv(h1_candles, DATA_DIR / "xauusd_h1.csv")


if __name__ == "__main__":
    main()
