"""terminal-manager — owns the MT5 terminal fleet on this host.

Endpoints (all require X-Manager-Secret):
  POST   /terminals                       provision {accountId, login, password, server}
  POST   /terminals/{account_id}/restart  watchdog hook — relaunch without new creds
  DELETE /terminals/{account_id}          deprovision (idempotent)
  GET    /health                          fleet states
  GET    /capacity                        capacity + verdict (spec §7 schema)
  *      /t/{account_id}/{path}           reverse-proxy to that terminal's worker

One terminal folder per account under MT5_ROOT/terminals/<accountId>,
cloned from MT5_ROOT/golden-template.zip. One worker process per terminal
(the MetaTrader5 lib is process-global). Registry state persists to
state.json so a manager restart re-adopts running terminals.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, Optional

import httpx
import psutil
from fastapi import FastAPI, HTTPException, Request, Response

# ── config ───────────────────────────────────────────────────────────────────
ENV_FILE = os.getenv('MANAGER_ENV_FILE')
if ENV_FILE and Path(ENV_FILE).exists():
    for line in Path(ENV_FILE).read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

MANAGER_SECRET = os.getenv('MANAGER_SECRET', '')
ROOT = Path(os.getenv('MT5_ROOT', r'C:\shamarx-mt5'))
TEMPLATE_ZIP = ROOT / 'golden-template.zip'
TERMINALS_DIR = ROOT / 'terminals'
STATE_FILE = ROOT / 'state.json'
MAX_TERMINALS = int(os.getenv('MAX_TERMINALS', '4'))
BASE_WORKER_PORT = int(os.getenv('BASE_WORKER_PORT', '9100'))
PYTHON = sys.executable
AVG_RSS_MB_DEFAULT = 450


class TerminalRegistry:
    """Port + slot bookkeeping, persisted so restarts re-adopt terminals."""

    def __init__(self, base_port: int = BASE_WORKER_PORT, max_terminals: int = MAX_TERMINALS):
        self.base_port = base_port
        self.max_terminals = max_terminals
        self.slots: Dict[str, int] = {}

    def allocate(self, account_id: str) -> int:
        if account_id in self.slots:
            return self.slots[account_id]
        if len(self.slots) >= self.max_terminals:
            raise RuntimeError('fleet full')
        used = set(self.slots.values())
        port = next(p for p in range(self.base_port, self.base_port + self.max_terminals * 2)
                    if p not in used)
        self.slots[account_id] = port
        return port

    def release(self, account_id: str) -> None:
        self.slots.pop(account_id, None)

    def port_for(self, account_id: str) -> Optional[int]:
        return self.slots.get(account_id)

    def save(self, path: Path = STATE_FILE) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.slots))

    @classmethod
    def load(cls, path: Path = STATE_FILE) -> 'TerminalRegistry':
        r = cls()
        if path.exists():
            r.slots = {k: int(v) for k, v in json.loads(path.read_text()).items()}
        return r


def capacity_verdict(running: int, max_terminals: int, free_mb: int, avg_rss_mb: int,
                     load15: float, vcpus: int, free_gb: float) -> dict:
    """Spec §7: OK / NEAR_CAPACITY / SCALE_UP + how many more accounts fit."""
    slot_headroom = max_terminals - running
    ram_headroom = max(0, int((free_mb - 512) // max(avg_rss_mb, 1)))
    additional = max(0, min(slot_headroom, ram_headroom))

    if running >= max_terminals or free_mb < 1.0 * avg_rss_mb or load15 > 0.8 * vcpus or free_gb < 5:
        verdict = 'SCALE_UP'
    elif running >= 0.7 * max_terminals or free_mb < 1.5 * avg_rss_mb:
        verdict = 'NEAR_CAPACITY'
    else:
        verdict = 'OK'

    rec = {
        'OK': f'{additional} more account(s) fit comfortably.',
        'NEAR_CAPACITY': f'{additional} slot(s) left. Plan resize before onboarding beyond that.',
        'SCALE_UP': 'Full or resource-starved. Resize instance (stop→type→start, ~10 min) or add a host.',
    }[verdict]
    return {
        'terminals': {'running': running, 'capacity': max_terminals, 'avgRssMb': avg_rss_mb},
        'headroom': {'additionalAccounts': additional},
        'verdict': verdict,
        'recommendation': rec,
    }


# ── FastAPI app ──────────────────────────────────────────────────────────────
app = FastAPI()
registry = TerminalRegistry.load()
procs: Dict[str, subprocess.Popen] = {}


def _auth(request: Request) -> None:
    if not MANAGER_SECRET or request.headers.get('X-Manager-Secret') != MANAGER_SECRET:
        raise HTTPException(401, 'bad manager secret')


def _terminal_dir(account_id: str) -> Path:
    return TERMINALS_DIR / account_id


def _spawn_worker(account_id: str, port: int) -> subprocess.Popen:
    env = {**os.environ,
           'WORKER_ACCOUNT_ID': account_id,
           'WORKER_PORT': str(port),
           'TERMINAL_PATH': str(_terminal_dir(account_id) / 'terminal64.exe')}
    return subprocess.Popen([PYTHON, str(Path(__file__).parent / 'worker.py')], env=env)


async def _worker_ready(port: int, timeout_s: int = 90) -> dict:
    """Poll the worker until the terminal is logged in, or fail loud."""
    deadline = time.time() + timeout_s
    last: dict = {}
    async with httpx.AsyncClient(timeout=5.0) as http:
        while time.time() < deadline:
            try:
                r = await http.get(f'http://127.0.0.1:{port}/init-status')
                last = r.json()
                if last.get('state') == 'CONNECTED':
                    return last
                if last.get('state') == 'AUTH_FAILED':
                    raise HTTPException(401, 'broker rejected login')
            except httpx.HTTPError:
                pass
            time.sleep(2)
    raise HTTPException(504, f'login not confirmed within {timeout_s}s: {last}')


def _kill_terminal(account_id: str) -> None:
    tdir = str(_terminal_dir(account_id)).lower()
    for proc in psutil.process_iter(['exe']):
        try:
            if proc.info['exe'] and tdir in proc.info['exe'].lower():
                proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass


@app.post('/terminals', status_code=201)
async def provision(request: Request):
    _auth(request)
    body = await request.json()
    account_id = body['accountId']

    try:
        port = registry.allocate(account_id)
    except RuntimeError:
        raise HTTPException(409, 'fleet full')

    tdir = _terminal_dir(account_id)
    try:
        if not tdir.exists():
            tdir.parent.mkdir(parents=True, exist_ok=True)
            shutil.unpack_archive(str(TEMPLATE_ZIP), str(tdir))
        cfg = tdir / 'config' / 'start.ini'
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(
            f"[Common]\nLogin={body['login']}\nPassword={body['password']}\nServer={body['server']}\n")

        # The WORKER launches the terminal via mt5.initialize() — a GUI exe
        # Popen'd from a Session-0 service never starts.
        procs[account_id] = _spawn_worker(account_id, port)
        info = await _worker_ready(port)
        registry.save()
        return {'status': 'CONNECTED', 'port': port,
                **{k: info.get(k) for k in ('balance', 'equity')}}
    except HTTPException:
        # fail clean: kill worker + terminal, remove folder, free the slot
        p = procs.pop(account_id, None)
        if p:
            p.kill()
        _kill_terminal(account_id)
        shutil.rmtree(tdir, ignore_errors=True)
        registry.release(account_id)
        registry.save()
        raise


@app.post('/terminals/{account_id}/restart')
async def restart(account_id: str, request: Request):
    """Watchdog hook: relaunch terminal + worker WITHOUT new creds — the
    terminal folder already holds its login config."""
    _auth(request)
    port = registry.port_for(account_id)
    if port is None:
        raise HTTPException(404, 'unknown account')
    p = procs.pop(account_id, None)
    if p:
        p.kill()
    _kill_terminal(account_id)
    procs[account_id] = _spawn_worker(account_id, port)
    info = await _worker_ready(port)
    return {'status': 'CONNECTED', **{k: info.get(k) for k in ('balance', 'equity')}}


@app.delete('/terminals/{account_id}', status_code=204)
async def deprovision(account_id: str, request: Request):
    _auth(request)
    p = procs.pop(account_id, None)
    if p:
        p.kill()
    _kill_terminal(account_id)
    shutil.rmtree(_terminal_dir(account_id), ignore_errors=True)
    registry.release(account_id)
    registry.save()
    return Response(status_code=204)


@app.get('/health')
async def health(request: Request):
    _auth(request)
    out = []
    for acct, port in registry.slots.items():
        alive = procs.get(acct) is not None and procs[acct].poll() is None
        out.append({'accountId': acct, 'port': port, 'workerAlive': alive})
    return {'status': 'ok', 'terminals': out}


@app.get('/capacity')
async def capacity(request: Request):
    _auth(request)
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage(str(ROOT.anchor))
    rss = [p.memory_info().rss / 1e6 for p in psutil.process_iter()
           if 'terminal64' in (p.name() or '').lower()]
    avg_rss = int(sum(rss) / len(rss)) if rss else AVG_RSS_MB_DEFAULT
    # getloadavg is unavailable on Windows < py3.13 psutil emulation; cpu_percent
    # over 1s is the portable signal, normalized to a load-style number.
    load15 = (psutil.cpu_percent(interval=1) / 100.0) * (psutil.cpu_count() or 1)
    body = capacity_verdict(
        running=len(registry.slots), max_terminals=registry.max_terminals,
        free_mb=int(vm.available / 1e6), avg_rss_mb=avg_rss,
        load15=load15, vcpus=psutil.cpu_count() or 1, free_gb=disk.free / 1e9,
    )
    body.update({
        'hostId': os.getenv('HOST_ID', 'mt5-host-01'),
        'memory': {'totalMb': int(vm.total / 1e6),
                   'usedMb': int((vm.total - vm.available) / 1e6),
                   'freeMb': int(vm.available / 1e6)},
        'disk': {'totalGb': round(disk.total / 1e9), 'freeGb': round(disk.free / 1e9)},
    })
    return body


@app.api_route('/t/{account_id}/{path:path}', methods=['GET', 'POST'])
async def proxy(account_id: str, path: str, request: Request):
    _auth(request)
    port = registry.port_for(account_id)
    if port is None:
        raise HTTPException(404, f'no terminal for account {account_id}')
    async with httpx.AsyncClient(timeout=30.0) as http:
        r = await http.request(request.method, f'http://127.0.0.1:{port}/{path}',
                               content=await request.body(),
                               params=dict(request.query_params))
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get('content-type'))


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=8100)
