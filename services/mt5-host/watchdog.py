"""watchdog — 30s supervision of the terminal fleet.

For each registered account: worker process alive? worker /init-status
responding and CONNECTED? Unhealthy terminals are restarted through the
manager's /terminals/{id}/restart hook (the manager owns launch logic;
the watchdog never duplicates it) with exponential backoff 1m→15m.

Heartbeats POST to the app server's internal endpoint
POST /api/internal/mt5-heartbeat {hostId, accountId, state}, which writes
Redis keys live:mt5host:<hostId>:<accountId> (TTL 300s) — surfaced by the
existing loop-health pill. APP_INTERNAL_URL unset = heartbeats skipped
(pre-integration bring-up).
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import httpx

ENV_FILE = os.getenv('MANAGER_ENV_FILE')
if ENV_FILE and Path(ENV_FILE).exists():
    for line in Path(ENV_FILE).read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

MANAGER = 'http://127.0.0.1:8100'
SECRET = os.getenv('MANAGER_SECRET', '')
APP_INTERNAL = os.getenv('APP_INTERNAL_URL', '')  # e.g. http://10.0.1.23:9000
HOST_ID = os.getenv('HOST_ID', 'mt5-host-01')
BACKOFF_CAP_S = 900

restarts: dict[str, tuple[int, float]] = {}  # accountId -> (count, next_allowed_ts)


def beat(account_id: str, state: str) -> None:
    if not APP_INTERNAL:
        return
    try:
        httpx.post(f'{APP_INTERNAL}/api/internal/mt5-heartbeat',
                   json={'hostId': HOST_ID, 'accountId': account_id, 'state': state},
                   timeout=5.0)
    except httpx.HTTPError:
        pass


def main() -> None:
    h = {'X-Manager-Secret': SECRET}
    while True:
        try:
            fleet = httpx.get(f'{MANAGER}/health', headers=h, timeout=10.0).json()['terminals']
        except Exception as e:  # manager itself down — NSSM restarts it; we just wait
            print(f'watchdog: manager unreachable: {e}', flush=True)
            time.sleep(30)
            continue

        for t in fleet:
            acct, port, alive = t['accountId'], t['port'], t['workerAlive']
            state = 'DOWN'
            if alive:
                try:
                    s = httpx.get(f'http://127.0.0.1:{port}/init-status', timeout=5.0).json()
                    state = s.get('state', 'UNKNOWN')
                except httpx.HTTPError:
                    state = 'WORKER_HUNG'
            beat(acct, state)

            if state in ('DOWN', 'WORKER_HUNG', 'TIMEOUT'):
                count, next_ok = restarts.get(acct, (0, 0.0))
                if time.time() >= next_ok:
                    delay = min(60 * 2 ** count, BACKOFF_CAP_S)
                    restarts[acct] = (count + 1, time.time() + delay)
                    print(f'watchdog: {acct} {state} → restart '
                          f'(attempt {count + 1}, next backoff {delay}s)', flush=True)
                    try:
                        httpx.post(f'{MANAGER}/terminals/{acct}/restart',
                                   headers=h, timeout=150.0)
                    except httpx.HTTPError as e:
                        print(f'watchdog: restart failed: {e}', flush=True)
            else:
                restarts.pop(acct, None)
        time.sleep(30)


if __name__ == '__main__':
    main()
