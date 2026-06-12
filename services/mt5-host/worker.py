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
import socket
import threading
import time
import uuid
from typing import Optional

from fastapi import FastAPI, HTTPException

ACCOUNT_ID = os.getenv('WORKER_ACCOUNT_ID', '')
PORT = int(os.getenv('WORKER_PORT', '9100'))
BRIDGE_PORT = int(os.getenv('BRIDGE_PORT', str(PORT + 1000)))

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


class Bridge:
    """Single-EA socket server with request/response correlation."""

    def __init__(self, port: int):
        self.port = port
        self.conn: Optional[socket.socket] = None
        self.lock = threading.Lock()
        self.pending: dict[str, list] = {}   # id -> [event, response]
        self.buf = b''
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(('127.0.0.1', self.port))
        srv.listen(1)
        print(f'[worker {ACCOUNT_ID}] bridge listening on 127.0.0.1:{self.port}', flush=True)
        while True:
            conn, _ = srv.accept()
            print(f'[worker {ACCOUNT_ID}] EA connected', flush=True)
            with self.lock:
                if self.conn:
                    try:
                        self.conn.close()
                    except OSError:
                        pass
                self.conn = conn
                self.buf = b''
            self._reader(conn)

    def _reader(self, conn: socket.socket):
        try:
            while True:
                data = conn.recv(65536)
                if not data:
                    break
                self.buf += data
                while b'\n' in self.buf:
                    line, self.buf = self.buf.split(b'\n', 1)
                    self._dispatch(line.decode('utf-8', 'replace').strip())
        except OSError:
            pass
        print(f'[worker {ACCOUNT_ID}] EA disconnected', flush=True)
        with self.lock:
            if self.conn is conn:
                self.conn = None

    def _dispatch(self, line: str):
        rid, _, rest = line.partition('|')
        waiter = self.pending.get(rid)
        if waiter:
            waiter[1] = rest
            waiter[0].set()

    @property
    def connected(self) -> bool:
        return self.conn is not None

    def call(self, op: str, *args: str, timeout: float = 15.0) -> str:
        """Returns the response payload after 'ok|'; raises on err/timeout."""
        with self.lock:
            conn = self.conn
        if conn is None:
            raise ConnectionError('EA not connected')
        rid = uuid.uuid4().hex[:8]
        ev = threading.Event()
        self.pending[rid] = [ev, None]
        msg = '|'.join([rid, op, *args]) + '\n'
        try:
            conn.sendall(msg.encode('utf-8'))
            if not ev.wait(timeout):
                raise TimeoutError(f'bridge op {op} timed out after {timeout}s')
            resp = self.pending[rid][1] or ''
        finally:
            self.pending.pop(rid, None)
        status, _, payload = resp.partition('|')
        if status != 'ok':
            raise RuntimeError(f'bridge op {op} failed: {payload or resp}')
        return payload


bridge = Bridge(BRIDGE_PORT)


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
            except (ConnectionError, TimeoutError, RuntimeError) as e:
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
        except (ConnectionError, TimeoutError, RuntimeError):
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
