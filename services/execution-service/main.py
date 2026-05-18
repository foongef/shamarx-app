import os
import time
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

from routes import orders_router, positions_router, account_router, candles_router
from historical_data import historical_router

load_dotenv()

app = FastAPI(title="Trading Bot Execution Service", version="1.0.0")

app.include_router(orders_router, prefix="/orders", tags=["orders"])
app.include_router(positions_router, prefix="/positions", tags=["positions"])
app.include_router(account_router, prefix="/account", tags=["account"])
app.include_router(candles_router, prefix="/candles", tags=["candles"])
app.include_router(historical_router, prefix="/historical-candles", tags=["historical"])


# Liveness watchdog. Any successful (2xx) response on a non-/health route
# updates this timestamp. /health reports the service unhealthy when the
# timestamp is more than STALE_THRESHOLD_SEC behind wall-clock.
#
# Why this exists: on 2026-05-18 the MetaApi WebSocket SDK went into a
# pathological retry state, saturating the asyncio event loop. Uvicorn
# stopped accepting new connections (TCP RST on localhost:8000/health).
# A vanilla /health that always returns 200 cannot detect this — the loop
# never gets to run the handler. Tracking liveness from completed requests
# means a starved loop naturally produces a stale timestamp, which surfaces
# the problem to Docker's healthcheck → triggers the autoheal sidecar.
_last_successful_op: float = time.time()
STALE_THRESHOLD_SEC: int = int(os.getenv("HEALTH_STALE_THRESHOLD_SEC", "300"))


@app.middleware("http")
async def mark_liveness(request: Request, call_next) -> Response:
    response = await call_next(request)
    if response.status_code < 400 and request.url.path != "/health":
        global _last_successful_op
        _last_successful_op = time.time()
    return response


@app.get("/health")
async def health():
    # Use the same mode-resolution as routes — Redis runtime override > env
    from routes import get_mode
    stale = time.time() - _last_successful_op
    body = {
        "service": "execution-service",
        "mode": get_mode(),
        "stale_seconds": int(stale),
        "stale_threshold_seconds": STALE_THRESHOLD_SEC,
    }
    if stale > STALE_THRESHOLD_SEC:
        return JSONResponse(
            status_code=503,
            content={**body, "status": "stale"},
        )
    return {**body, "status": "ok"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("EXECUTION_PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
