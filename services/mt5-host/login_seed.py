"""login_seed — logs an MT5 account into ONE terminal via the Navigator
panel, because build 5836 dropped config-file auto-login AND removed the
File-menu login item (login now lives only in Navigator right-click).

Runs INSIDE the interactive session. After a successful login with 'save
account' the terminal persists it and reconnects forever after.

Env: SEED_LOGIN, SEED_PASSWORD, SEED_SERVER, TERMINAL_PATH
PROBE=shot : save a screenshot to SHOT_PATH and exit (for blind dev)
PROBE=tree : dump the full control tree and exit
Exit: 0 submitted · 2 no terminal · 3 navigator not found · 4 dialog fail
"""
from __future__ import annotations

import os
import sys
import time

from pywinauto import Application, Desktop
from pywinauto.keyboard import send_keys


def _hide_own_console():
    """Our cmd.exe console covers the terminal and steals coordinate clicks.
    Minimize it so screenshots and click_input reach MT5."""
    try:
        import ctypes
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
    except Exception:
        pass

TERMINAL_PATH = os.getenv('TERMINAL_PATH', '')
PROBE = os.getenv('PROBE', '')
SHOT_PATH = os.getenv('SHOT_PATH', r'C:\shamarx-mt5\shot.png')


def esc_keys(text: str) -> str:
    """Escape pywinauto send_keys metacharacters in a literal string."""
    out = []
    for ch in text:
        if ch in '+^%~(){}[]':
            out.append('{' + ch + '}')
        else:
            out.append(ch)
    return ''.join(out)


def find_terminal(timeout_s: int = 60):
    import psutil
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for w in Desktop(backend='win32').windows():
            try:
                exe = (psutil.Process(w.process_id()).exe() or '').lower()
                if TERMINAL_PATH.lower() == exe and w.is_visible():
                    return w
            except Exception:
                continue
        time.sleep(2)
    return None


def main() -> int:
    _hide_own_console()
    win = find_terminal()
    if win is None:
        print('terminal window not found', flush=True)
        return 2
    pid = win.process_id()
    print(f'terminal: "{win.window_text()}" pid={pid}', flush=True)
    app = Application(backend='win32').connect(process=pid)

    try:
        win.maximize()
    except Exception as e:
        print(f'maximize best-effort: {e}', flush=True)
    time.sleep(1)

    if PROBE == 'shot':
        try:
            win.capture_as_image().save(SHOT_PATH)
            print(f'screenshot saved: {SHOT_PATH}', flush=True)
        except Exception as e:
            print(f'screenshot failed: {e}', flush=True)
        return 0

    if PROBE == 'tree':
        win.print_control_identifiers(depth=4)
        return 0

    # ── Real login via Navigator ──────────────────────────────────────────
    login = os.environ['SEED_LOGIN']
    password = os.environ['SEED_PASSWORD']
    server = os.environ['SEED_SERVER']

    # Navigator is already open by default. The Navigator is a SysTreeView32
    # whose roots include an "Accounts" node.
    tree = None
    for child in win.descendants():
        try:
            if 'TreeView' in child.class_name():
                tree = child
                break
        except Exception:
            continue
    if tree is None:
        print('navigator tree not found', flush=True)
        return 3
    print('navigator tree found', flush=True)

    try:
        tree.set_focus()
    except Exception:
        pass
    items = tree.roots() if hasattr(tree, 'roots') else []
    accounts_node = None
    for it in items:
        if 'account' in (it.text() or '').lower():
            accounts_node = it
            break
    if accounts_node is None and items:
        accounts_node = items[0]
    if accounts_node is None:
        print('accounts node not found in navigator', flush=True)
        return 3
    print(f'accounts node: "{accounts_node.text()}"', flush=True)
    accounts_node.click_input(button='right')
    time.sleep(1.2)

    if os.getenv('STAGE') == 'menu':
        menu = app.window(class_name='#32768')
        if menu.exists():
            for entry in menu.children():
                print('MENUITEM:', repr(entry.window_text()), flush=True)
            try:
                win.capture_as_image().save(SHOT_PATH)
                print(f'menu screenshot: {SHOT_PATH}', flush=True)
            except Exception:
                pass
        else:
            print('no context menu appeared', flush=True)
        return 0

    # Context menu (#32768) → "Login to Trade Account"
    menu = app.window(class_name='#32768')
    if menu.exists():
        clicked = False
        for entry in menu.children():
            if 'login' in (entry.window_text() or '').lower():
                entry.click_input()
                clicked = True
                break
        if not clicked:
            send_keys('l')
    else:
        send_keys('l')
    time.sleep(2)

    # ── Fill the login dialog (#32770) ────────────────────────────────────
    dlg = None
    for _ in range(8):
        d = app.window(class_name='#32770')
        if d.exists() and d.is_visible():
            dlg = d
            break
        time.sleep(1)
    if dlg is None:
        print('login dialog never appeared', flush=True)
        return 4
    print(f'dialog: "{dlg.window_text()}"', flush=True)

    if os.getenv('DIALOG_SHOT') == '1':
        try:
            dlg.capture_as_image().save(SHOT_PATH)
            print(f'dialog screenshot: {SHOT_PATH}', flush=True)
        except Exception:
            pass

    try:
        combos = dlg.children(class_name='ComboBox')
        edits = dlg.children(class_name='Edit')
        if combos:
            combos[0].set_focus(); send_keys('^a{DEL}'); send_keys(esc_keys(login))
        std_edits = [e for e in edits if e.parent().class_name() == '#32770']
        pw_edit = std_edits[0] if std_edits else (edits[0] if edits else None)
        if pw_edit:
            pw_edit.set_focus(); send_keys('^a{DEL}'); send_keys(esc_keys(password))
        if len(combos) > 1:
            combos[1].set_focus(); send_keys('^a{DEL}'); send_keys(esc_keys(server))
        for cb in dlg.children(class_name='Button'):
            if 'save' in (cb.window_text() or '').lower():
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
