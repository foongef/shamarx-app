"""worker — binds the official MetaTrader5 lib to ONE terminal and exposes
the Broker verbs on localhost. One process per terminal (the lib is
process-global). The manager's reverse-proxy is the only caller."""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

from fastapi import FastAPI, HTTPException

ACCOUNT_ID = os.getenv('WORKER_ACCOUNT_ID', '')
PORT = int(os.getenv('WORKER_PORT', '9100'))
TERMINAL_PATH = os.getenv('TERMINAL_PATH', '')

app = FastAPI()
state = {'state': 'INITIALIZING', 'error': None}

# MetaTrader5 import is win32-only; deferred so tests import this module anywhere.
mt5 = None

TIMEFRAMES = {'M15': 15, 'H1': 16385, 'D1': 16408}


def timeframe_to_mt5(tf: str) -> int:
    if tf not in TIMEFRAMES:
        raise ValueError(f'unsupported timeframe {tf}')
    return TIMEFRAMES[tf]


def mt5_position_to_dict(p) -> dict:
    return {
        'ticket': int(p.ticket), 'symbol': p.symbol,
        'side': 'BUY' if p.type == 0 else 'SELL',
        'lotSize': float(p.volume), 'entryPrice': float(p.price_open),
        'currentPrice': float(p.price_current), 'sl': float(p.sl), 'tp': float(p.tp),
        'pnl': float(p.profit), 'openTime': str(int(p.time)),
    }


def _read_start_ini() -> dict:
    """Login config written by the manager into this terminal's folder."""
    from pathlib import Path as _P
    ini = _P(TERMINAL_PATH).parent / 'config' / 'start.ini'
    creds = {}
    for line in ini.read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            creds[k.strip().lower()] = v.strip()
    return creds


def _init_terminal():
    global mt5
    import MetaTrader5 as _mt5
    mt5 = _mt5
    # initialize() LAUNCHES the terminal itself and logs in — the documented
    # headless pattern. (Popen-launching a GUI exe from a Session-0 Windows
    # service silently fails; the lib's launcher does not.)
    try:
        c = _read_start_ini()
    except OSError as e:
        state.update(state='TIMEOUT', error=f'start.ini unreadable: {e}')
        return
    for attempt in range(3):
        print(f'[worker {ACCOUNT_ID}] initialize attempt {attempt + 1} '
              f'path={TERMINAL_PATH} server={c.get("server")}', flush=True)
        ok = mt5.initialize(path=TERMINAL_PATH, login=int(c['login']),
                            password=c['password'], server=c['server'],
                            portable=True, timeout=60_000)
        print(f'[worker {ACCOUNT_ID}] initialize -> {ok}, last_error={mt5.last_error()}', flush=True)
        if ok:
            info = mt5.account_info()
            print(f'[worker {ACCOUNT_ID}] account_info={info}', flush=True)
            if info is not None and info.login:
                state.update(state='CONNECTED')
                return
        code, desc = mt5.last_error()
        if code == -6:  # authorization failed — no point retrying
            state.update(state='AUTH_FAILED', error=f'{code}: {desc}')
            return
        time.sleep(5)
    code, desc = mt5.last_error()
    state.update(state='TIMEOUT', error=f'{code}: {desc}')


@app.on_event('startup')
def startup():
    threading.Thread(target=_init_terminal, daemon=True).start()


@app.get('/init-status')
def init_status():
    body = dict(state)
    if state['state'] == 'CONNECTED' and mt5:
        info = mt5.account_info()
        if info:
            body.update(balance=info.balance, equity=info.equity)
    return body


def _require_connected():
    if state['state'] != 'CONNECTED' or mt5 is None:
        raise HTTPException(503, f'terminal not connected: {state}')


@app.get('/positions')
def positions(symbol: Optional[str] = None):
    _require_connected()
    res = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
    return [mt5_position_to_dict(p) for p in (res or [])]


@app.get('/account-info')
def account_info():
    _require_connected()
    a = mt5.account_info()
    if a is None:
        raise HTTPException(502, f'account_info failed: {mt5.last_error()}')
    return {'balance': a.balance, 'equity': a.equity, 'margin': a.margin,
            'freeMargin': a.margin_free,
            'openPositions': len(mt5.positions_get() or [])}


@app.post('/orders')
def place_order(body: dict):
    _require_connected()
    symbol, side = body['symbol'], body['side']
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise HTTPException(400, f'symbol {symbol} unavailable')
    req = {
        'action': mt5.TRADE_ACTION_DEAL, 'symbol': symbol,
        'volume': float(body['lotSize']),
        'type': mt5.ORDER_TYPE_BUY if side == 'BUY' else mt5.ORDER_TYPE_SELL,
        'price': tick.ask if side == 'BUY' else tick.bid,
        'sl': float(body['slPrice']), 'tp': float(body['tpPrice']),
        'deviation': 20, 'type_filling': mt5.ORDER_FILLING_IOC,
        'comment': body.get('comment') or 'GIDEON',
    }
    r = mt5.order_send(req)
    if r is None or r.retcode != mt5.TRADE_RETCODE_DONE:
        return {'orderId': '', 'mt5Ticket': None, 'status': 'REJECTED',
                'message': f'retcode={getattr(r, "retcode", "none")} {getattr(r, "comment", "")}'}
    return {'orderId': str(r.order), 'mt5Ticket': int(r.order), 'status': 'FILLED',
            'message': r.comment or 'done'}


@app.post('/positions/{ticket}/modify')
def modify(ticket: int, body: dict):
    _require_connected()
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        raise HTTPException(404, f'position {ticket} not found')
    r = mt5.order_send({'action': mt5.TRADE_ACTION_SLTP, 'position': ticket,
                        'symbol': pos[0].symbol,
                        'sl': float(body['slPrice']), 'tp': float(body['tpPrice'])})
    if r is None or r.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(502, f'modify failed: retcode={getattr(r, "retcode", "none")}')
    return {'status': 'OK'}


@app.post('/positions/{ticket}/close')
def close(ticket: int):
    _require_connected()
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        raise HTTPException(404, f'position {ticket} not found')
    p = pos[0]
    tick = mt5.symbol_info_tick(p.symbol)
    r = mt5.order_send({
        'action': mt5.TRADE_ACTION_DEAL, 'position': ticket, 'symbol': p.symbol,
        'volume': p.volume,
        'type': mt5.ORDER_TYPE_SELL if p.type == 0 else mt5.ORDER_TYPE_BUY,
        'price': tick.bid if p.type == 0 else tick.ask,
        'deviation': 20, 'type_filling': mt5.ORDER_FILLING_IOC,
    })
    ok = r is not None and r.retcode == mt5.TRADE_RETCODE_DONE
    return {'status': 'CLOSED' if ok else 'REJECTED'}


@app.get('/positions/{ticket}/history')
def history(ticket: int):
    _require_connected()
    deals = mt5.history_deals_get(position=ticket)
    if not deals:
        return None
    exit_deals = [d for d in deals if d.entry == 1]  # DEAL_ENTRY_OUT
    if not exit_deals:
        return None
    d = exit_deals[-1]
    return {'ticket': ticket, 'closePrice': d.price,
            'realizedPnl': sum(x.profit + x.commission + x.swap for x in exit_deals),
            'exitReason': 'SL' if d.reason == 4 else 'TP' if d.reason == 5 else 'CLOSED',
            'closeTime': str(int(d.time))}


@app.get('/candles')
def candles(timeframe: str = 'M15', count: int = 100, symbol: Optional[str] = None):
    _require_connected()
    sym = symbol or 'EURUSD'
    rates = mt5.copy_rates_from_pos(sym, timeframe_to_mt5(timeframe), 0, count + 1)
    if rates is None:
        raise HTTPException(502, f'copy_rates failed: {mt5.last_error()}')
    out = [{'symbol': sym, 'timeframe': timeframe,
            'openTime': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(int(r['time']))),
            'open': float(r['open']), 'high': float(r['high']),
            'low': float(r['low']), 'close': float(r['close']),
            'volume': float(r['tick_volume'])} for r in rates]
    return out[:-1]  # drop the forming bar — Candle-table invariant


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=PORT)
