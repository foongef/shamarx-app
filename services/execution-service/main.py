import os
from fastapi import FastAPI
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


@app.get("/health")
async def health():
    mode = os.getenv("MT5_MODE", "mock")
    return {"status": "ok", "service": "execution-service", "mode": mode}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("EXECUTION_PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
