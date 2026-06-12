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
    """The MT5 MAIN window (class 'MetaQuotes::MetaTrader::5.00'), not a child
    dialog like the Login popup that also belongs to terminal64.exe."""
    import psutil
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        candidates = []
        for w in Desktop(backend='win32').windows():
            try:
                exe = (psutil.Process(w.process_id()).exe() or '').lower()
                if TERMINAL_PATH.lower() != exe or not w.is_visible():
                    continue
                cls = w.class_name() or ''
                if 'MetaQuotes' in cls or 'MetaTrader' in cls:
                    return w  # the real main window class
                candidates.append(w)
            except Exception:
                continue
        # fallback: longest title, excluding the "Login" dialog
        named = [w for w in candidates if (w.window_text() or '') not in ('Login', '')]
        if named:
            return max(named, key=lambda w: len(w.window_text() or ''))
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

    # Already logged into the target account? (title carries the login number)
    if login in (win.window_text() or ''):
        print('already logged into target account', flush=True)
        return 0

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
    # Walk the tree: roots + their children. "Accounts" is a child of the
    # "MetaTrader 5" root.
    def walk(nodes):
        for n in nodes:
            yield n
            try:
                yield from walk(n.children())
            except Exception:
                pass
    accounts_node = None
    try:
        all_nodes = list(walk(tree.roots()))
    except Exception:
        all_nodes = tree.roots()
    for it in all_nodes:
        try:
            if (it.text() or '').strip().lower() == 'accounts':
                accounts_node = it
                break
        except Exception:
            continue
    if accounts_node is None:
        print('accounts node not found; tree was: ' +
              ', '.join(repr(n.text()) for n in all_nodes[:12]), flush=True)
        return 3
    print(f'accounts node: "{accounts_node.text()}"', flush=True)
    # FULLY MESSAGE-BASED (display-less EC2 has no input desktop, so
    # SendInput/SetCursorPos fail). TVM_SELECTITEM selects the node; then
    # PostMessage WM_KEYDOWN/UP VK_RETURN to the tree triggers its default
    # action = "Login to Trade Account" (Enter accelerator on a selected
    # Accounts node).
    import win32gui, win32con
    TVM_SELECTITEM = 0x110B
    TVGN_CARET = 0x0009
    try:
        h_tree = tree.handle
        h_item = accounts_node.elem if hasattr(accounts_node, 'elem') else None
        if h_item:
            win32gui.SendMessage(h_tree, TVM_SELECTITEM, TVGN_CARET, h_item)
        win32gui.PostMessage(h_tree, win32con.WM_KEYDOWN, win32con.VK_RETURN, 0)
        win32gui.PostMessage(h_tree, win32con.WM_KEYUP, win32con.VK_RETURN, 0)
    except Exception as e:
        print(f'message select/enter failed: {e}', flush=True)
    time.sleep(1.5)

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

    # Context menu order: [Open an Account, Login to Trade Account, ...].
    # win32 popup items aren't text-enumerable, so select the 2nd by keyboard.
    send_keys('{DOWN}{DOWN}{ENTER}')
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

    if os.getenv('STAGE') == 'dialog':
        try:
            win.capture_as_image().save(SHOT_PATH)
            print(f'dialog screenshot: {SHOT_PATH}', flush=True)
            print('combos=' + str(len(dlg.children(class_name='ComboBox'))) +
                  ' edits=' + str(len(dlg.children(class_name='Edit'))), flush=True)
        except Exception as e:
            print('dialog probe failed:', e, flush=True)
        return 0

    if os.getenv('DIALOG_SHOT') == '1':
        try:
            dlg.capture_as_image().save(SHOT_PATH)
            print(f'dialog screenshot: {SHOT_PATH}', flush=True)
        except Exception:
            pass

    try:
        import win32gui, win32con
        combos = dlg.children(class_name='ComboBox')
        edits = dlg.children(class_name='Edit')
        def set_combo_text(combo, value):
            # the editable part of a ComboBox is a child Edit
            for c in combo.children():
                if c.class_name() == 'Edit':
                    win32gui.SendMessage(c.handle, win32con.WM_SETTEXT, 0, value)
                    return
            win32gui.SendMessage(combo.handle, win32con.WM_SETTEXT, 0, value)
        if combos:
            set_combo_text(combos[0], login)
        std_edits = [e for e in edits if e.parent().class_name() == '#32770']
        pw_edit = std_edits[0] if std_edits else (edits[0] if edits else None)
        if pw_edit:
            win32gui.SendMessage(pw_edit.handle, win32con.WM_SETTEXT, 0, password)
        if len(combos) > 1:
            set_combo_text(combos[1], server)
        for cb in dlg.children(class_name='Button'):
            if 'save' in (cb.window_text() or '').lower():
                try:
                    if cb.get_check_state() == 0:
                        cb.click()
                        print('ticked Save password', flush=True)
                except Exception:
                    pass
        time.sleep(0.5)
        ok = None
        for b in dlg.children(class_name='Button'):
            if (b.window_text() or '').strip().lower() in ('ok', '&ok'):
                ok = b
                break
        if ok:
            try:
                ok.click()  # message-based, no cursor move
            except Exception:
                send_keys('{ENTER}')
            print('clicked OK', flush=True)
        else:
            send_keys('{ENTER}')
            print('pressed ENTER (no OK button found)', flush=True)
        time.sleep(8)
        if os.getenv('RESULT_SHOT') == '1':
            try:
                win.capture_as_image().save(SHOT_PATH)
                print('result screenshot saved', flush=True)
            except Exception:
                pass
        return 0
    except Exception as e:
        print(f'control interaction failed: {e}', flush=True)
        return 4


if __name__ == '__main__':
    sys.exit(main())
