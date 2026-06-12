"""worker — bridges HTTP verbs to the ShamarxBridge EA inside ONE terminal.

The official MetaTrader5 python lib was abandoned after persistent IPC
failures (-10001/-10005) against terminal build 5836 — see Spec 4 notes.
Instead the worker LISTENS on a local port; the EA (MQL5 sockets are
client-only) connects out to us and serves a pipe-delimited protocol:

  request : <id>|<op>|<args...>\\n
  response: <id>|ok|<fields...>\\n  or  <id>|err|<message>\\n

The terminal-manager launches the terminal (interactive session — Popen
works there) with start.ini auto-login + [StartUp] Expert=ShamarxBridge.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException

ACCOUNT_ID = os.getenv('WORKER_ACCOUNT_ID', '')
PORT = int(os.getenv('WORKER_PORT', '9100'))
FILES_DIR = Path(os.getenv("TERMINAL_DIR", ".")) / "MQL5" / "Files"

app = FastAPI()
state = {'state': 'INITIALIZING', 'error': None}

TIMEFRAMES = ('M15', 'H1', 'D1')


def timeframe_check(tf: str) -> str:
    if tf not in TIMEFRAMES:
        raise ValueError(f'unsupported timeframe {tf}')
    return tf


def position_row_to_dict(row: str) -> dict:
    f = row.split(',')
    return {
        'ticket': int(f[0]), 'symbol': f[1], 'side': f[2],
        'lotSize': float(f[3]), 'entryPrice': float(f[4]),
        'currentPrice': float(f[5]), 'sl': float(f[6]), 'tp': float(f[7]),
        'pnl': float(f[8]), 'openTime': f[9],
    }


class FileBridge:
    """Request/response over the terminal's MQL5\\Files sandbox.

    SocketConnect is blocked headless (4014: destination whitelist is
    GUI-only), so the EA polls shamarx_req.txt every 200ms and answers in
    shamarx_resp.txt. One in-flight request at a time, serialized here -
    ample for M15 cadence + 2s position polls.
    """

    def __init__(self, files_dir: Path):
        self.dir = files_dir
        self.req = files_dir / "shamarx_req.txt"
        self.resp = files_dir / "shamarx_resp.txt"
        self.alive = files_dir / "shamarx_alive.txt"
        self.lock = threading.Lock()

    @property
    def connected(self) -> bool:
        return self.alive.exists()

    def call(self, op: str, *args: str, timeout: float = 15.0) -> str:
        with self.lock:
            rid = uuid.uuid4().hex[:8]
            self.resp.unlink(missing_ok=True)
            self.dir.mkdir(parents=True, exist_ok=True)
            tmp = self.req.with_suffix(".tmp")
            tmp.write_text("|".join([rid, op, *args]) + "\n", encoding="utf-8")
            os.replace(tmp, self.req)
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    raw = self.resp.read_text(encoding="utf-8", errors="replace").strip()
                except (FileNotFoundError, PermissionError):
                    time.sleep(0.05)
                    continue
                if not raw.startswith(rid + "|"):
                    time.sleep(0.05)
                    continue
                _, _, rest = raw.partition("|")
                status, _, payload = rest.partition("|")
                if status != "ok":
                    raise RuntimeError(f"bridge op {op} failed: {payload or rest}")
                return payload
            raise TimeoutError(f"bridge op {op} timed out after {timeout}s")


bridge = FileBridge(FILES_DIR)


def _init_watch():
    """CONNECTED once the EA reports a broker-connected account; AUTH_FAILED
    if the EA is up but the terminal never authorizes within the budget."""
    deadline = time.time() + 150
    ea_seen = False
    while time.time() < deadline:
        if bridge.connected:
            ea_seen = True
            try:
                f = bridge.call('account', timeout=5).split('|')
                if f[0] == '1' and int(f[1]) > 0:
                    state.update(state='CONNECTED')
                    print(f'[worker {ACCOUNT_ID}] CONNECTED login={f[1]}', flush=True)
                    return
            except (OSError, TimeoutError, RuntimeError) as e:
                print(f'[worker {ACCOUNT_ID}] account poll: {e}', flush=True)
        time.sleep(3)
    state.update(
        state='AUTH_FAILED' if ea_seen else 'TIMEOUT',
        error='terminal never authorized with broker (check credentials)' if ea_seen
        else 'EA never connected — terminal may not have started')


@app.on_event('startup')
def startup():
    threading.Thread(target=_init_watch, daemon=True).start()


@app.get('/init-status')
def init_status():
    body = dict(state)
    if state['state'] == 'CONNECTED':
        try:
            f = bridge.call('account', timeout=5).split('|')
            body.update(balance=float(f[2]), equity=float(f[3]))
        except (OSError, TimeoutError, RuntimeError):
            pass
    return body


def _require_connected():
    if state['state'] != 'CONNECTED' or not bridge.connected:
        raise HTTPException(503, f'terminal not connected: {state}')


@app.get('/positions')
def positions(symbol: Optional[str] = None):
    _require_connected()
    payload = bridge.call('positions', symbol or '')
    return [position_row_to_dict(r) for r in payload.split(';') if r]


@app.get('/account-info')
def account_info():
    _require_connected()
    f = bridge.call('account').split('|')
    return {'balance': float(f[2]), 'equity': float(f[3]), 'margin': float(f[4]),
            'freeMargin': float(f[5]), 'openPositions': int(f[6])}


@app.post('/orders')
def place_order(body: dict):
    _require_connected()
    try:
        payload = bridge.call('order', body['symbol'], body['side'],
                              str(body['lotSize']), str(body['slPrice']),
                              str(body['tpPrice']), (body.get('comment') or 'GIDEON'),
                              timeout=30.0)
        ticket, _, fill = payload.partition('|')
        return {'orderId': ticket, 'mt5Ticket': int(ticket), 'status': 'FILLED',
                'message': f'filled @ {fill}'}
    except RuntimeError as e:
        return {'orderId': '', 'mt5Ticket': None, 'status': 'REJECTED', 'message': str(e)}


@app.post('/positions/{ticket}/modify')
def modify(ticket: int, body: dict):
    _require_connected()
    try:
        bridge.call('modify', str(ticket), str(body['slPrice']), str(body['tpPrice']))
        return {'status': 'OK'}
    except RuntimeError as e:
        raise HTTPException(502, f'modify failed: {e}')


@app.post('/positions/{ticket}/close')
def close(ticket: int):
    _require_connected()
    try:
        bridge.call('close', str(ticket), timeout=30.0)
        return {'status': 'CLOSED'}
    except RuntimeError:
        return {'status': 'REJECTED'}


@app.get('/positions/{ticket}/history')
def history(ticket: int):
    _require_connected()
    payload = bridge.call('history', str(ticket))
    if not payload:
        return None
    f = payload.split('|')
    return {'ticket': ticket, 'closePrice': float(f[0]), 'realizedPnl': float(f[1]),
            'exitReason': f[2], 'closeTime': f[3]}


@app.get('/candles')
def candles(timeframe: str = 'M15', count: int = 100, symbol: Optional[str] = None):
    _require_connected()
    sym = symbol or 'EURUSD'
    payload = bridge.call('candles', sym, timeframe_check(timeframe), str(count), timeout=20.0)
    out = []
    for row in payload.split(';'):
        if not row:
            continue
        t, o, h, l, c, v = row.split(',')
        out.append({'symbol': sym, 'timeframe': timeframe,
                    'openTime': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(int(t))),
                    'open': float(o), 'high': float(h), 'low': float(l),
                    'close': float(c), 'volume': float(v)})
    # EA returns series order (newest first) — consumers expect oldest first
    out.reverse()
    return out


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=PORT)
