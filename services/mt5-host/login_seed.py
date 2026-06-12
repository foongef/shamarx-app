"""login_seed — drives the MT5 'Login to Trade Account' dialog once per
terminal, because build 5836 ignores start-config [Common] auto-login.

Runs INSIDE the interactive session (spawned by the manager, itself a
logon-session scheduled task). After a successful dialog submit with
'Save password' ticked, the terminal persists the account and reconnects
by itself forever after — this script never runs again for that terminal.

Env: SEED_LOGIN, SEED_PASSWORD, SEED_SERVER, TERMINAL_PATH
Exit codes: 0 seeded (dialog submitted) · 2 terminal not found ·
            3 dialog never appeared · 4 controls missing
Mode PROBE=1: dump the dialog's control tree to stdout and exit.
"""
from __future__ import annotations

import os
import sys
import time

from pywinauto import Application, Desktop
from pywinauto.keyboard import send_keys

TERMINAL_PATH = os.getenv('TERMINAL_PATH', '')
PROBE = os.getenv('PROBE') == '1'


def find_terminal_window(timeout_s: int = 60):
    """The MT5 main window for OUR terminal instance (match by exe path)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for w in Desktop(backend='win32').windows():
            try:
                pid = w.process_id()
                import psutil
                exe = (psutil.Process(pid).exe() or '').lower()
                if TERMINAL_PATH.lower() == exe and w.is_visible():
                    return w, pid
            except Exception:
                continue
        time.sleep(2)
    return None, None


def main() -> int:
    win, pid = find_terminal_window()
    if win is None:
        print('terminal window not found', flush=True)
        return 2
    print(f'terminal window: "{win.window_text()}" pid={pid}', flush=True)

    app = Application(backend='win32').connect(process=pid)
    win.set_focus()
    time.sleep(1)

    # File menu -> first item starting with 'L' = "Login to Trade Account"
    send_keys('%f')          # Alt+F
    time.sleep(0.8)
    send_keys('l{ENTER}')
    time.sleep(1.5)

    # The login dialog is a native #32770
    dlg = None
    for _ in range(10):
        try:
            dlg = app.window(class_name='#32770')
            if dlg.exists() and dlg.is_visible():
                break
        except Exception:
            pass
        time.sleep(1)
    if dlg is None or not dlg.exists():
        print('login dialog never appeared', flush=True)
        return 3

    print(f'dialog: "{dlg.window_text()}"', flush=True)
    if PROBE:
        dlg.print_control_identifiers(depth=3)
        send_keys('{ESC}')
        return 0

    login, password, server = (os.environ['SEED_LOGIN'],
                               os.environ['SEED_PASSWORD'],
                               os.environ['SEED_SERVER'])
    try:
        combos = dlg.children(class_name='ComboBox')
        edits = dlg.children(class_name='Edit')
        # Dialog layout (probed): ComboBox[0]=Login, Edit (outside combos)=
        # Password, ComboBox[1]=Server. Password edit may be a child of a
        # combo on some builds — prefer the standalone Edit.
        combos[0].set_focus()
        send_keys('^a{DEL}')
        send_keys(login, with_spaces=True)
        pw = [e for e in edits if e.parent().class_name() == '#32770']
        target_pw = pw[0] if pw else edits[0]
        target_pw.set_focus()
        send_keys('^a{DEL}')
        send_keys(password, with_spaces=True)
        combos[1].set_focus()
        send_keys('^a{DEL}')
        send_keys(server, with_spaces=True)
        # tick "Save password" if present and unchecked
        for cb in dlg.children(class_name='Button'):
            txt = (cb.window_text() or '').lower()
            if 'save' in txt and hasattr(cb, 'get_check_state'):
                try:
                    if cb.get_check_state() == 0:
                        cb.click()
                except Exception:
                    pass
        time.sleep(0.5)
        send_keys('{ENTER}')
        print('dialog submitted', flush=True)
        return 0
    except Exception as e:
        print(f'control interaction failed: {e}', flush=True)
        return 4


if __name__ == '__main__':
    sys.exit(main())
