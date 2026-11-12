"""Real Windows input helper for the scroll probes.

The probes that already exist drive the wheel through CDP, which injects
*pixel-precise* deltas and therefore never enters Chromium's animated
"one notch -> one scroll curve" path. The user's stuck-at-the-bottom report
lives in that path, so a probe that wants to see it has to send real
WM_MOUSEWHEEL input to the real window.

Subcommands (all print one JSON line to stdout):

  windows                  list top-level frames + Chrome child windows
  focus <hwnd>             SetForegroundWindow + report the rect it ended up with
  wheel <x> <y> <delta> <n> [gap_ms]
                           move the cursor to (x, y) and send n notches of delta

Coordinates are physical screen pixels. Nothing here touches the page: the
caller reads scrollTop through CDP before/after.
"""
import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.SetProcessDPIAware()

MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


class RECT(ctypes.Structure):
    _fields_ = [("left", wt.LONG), ("top", wt.LONG), ("right", wt.LONG), ("bottom", wt.LONG)]


class POINT(ctypes.Structure):
    _fields_ = [("x", wt.LONG), ("y", wt.LONG)]


def _text(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _class(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _rect(hwnd):
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return {"l": r.left, "t": r.top, "r": r.right, "b": r.bottom,
            "w": r.right - r.left, "h": r.bottom - r.top}


def _client_origin(hwnd):
    r = RECT()
    user32.GetClientRect(hwnd, ctypes.byref(r))
    pt = POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return {"x": pt.x, "y": pt.y, "w": r.right - r.left, "h": r.bottom - r.top}


def _children(hwnd):
    out = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(child, _):
        out.append(child)
        return True

    user32.EnumChildWindows(hwnd, cb, 0)
    return out


def cmd_windows():
    frames = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        title = _text(hwnd)
        if not title:
            return True
        frames.append({"hwnd": hwnd, "class": _class(hwnd), "title": title, "rect": _rect(hwnd)})
        return True

    user32.EnumWindows(cb, 0)
    frames = [f for f in frames if f["rect"]["w"] > 300 and f["rect"]["h"] > 200]
    result = {"frames": frames, "chrome_children": []}
    for f in frames:
        if "idea" in f["class"].lower() or "awt" in f["class"].lower() or "WebStorm" in f["title"]:
            for ch in _children(f["hwnd"]):
                cls = _class(ch)
                if cls.lower().startswith("chrome") or "cef" in cls.lower():
                    result["chrome_children"].append(
                        {"parent": f["hwnd"], "hwnd": ch, "class": cls,
                         "visible": bool(user32.IsWindowVisible(ch)), "rect": _rect(ch)}
                    )
    return result


def cmd_focus(hwnd):
    hwnd = int(hwnd)
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    ok = user32.SetForegroundWindow(hwnd)
    time.sleep(0.35)
    fg = user32.GetForegroundWindow()
    return {"set_foreground_ok": bool(ok), "foreground": fg, "want": hwnd,
            "matched": fg == hwnd, "rect": _rect(hwnd)}


def cmd_wheel(x, y, delta, n, gap_ms=16):
    x, y, delta, n, gap_ms = int(x), int(y), int(delta), int(n), int(gap_ms)
    user32.SetCursorPos(x, y)
    time.sleep(0.05)
    sent = 0
    for _ in range(n):
        user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, 0)
        sent += 1
        if gap_ms:
            time.sleep(gap_ms / 1000.0)
    return {"sent": sent, "delta": delta, "at": {"x": x, "y": y}, "gap_ms": gap_ms}


def cmd_move(x, y):
    x, y = int(x), int(y)
    user32.SetCursorPos(x, y)
    return {"moved": {"x": x, "y": y}}


def cmd_click(x, y):
    x, y = int(x), int(y)
    user32.SetCursorPos(x, y)
    time.sleep(0.12)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.15)
    return {"clicked": {"x": x, "y": y}, "foreground": user32.GetForegroundWindow()}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "windows"
    if cmd == "windows":
        out = cmd_windows()
    elif cmd == "focus":
        out = cmd_focus(sys.argv[2])
    elif cmd == "wheel":
        out = cmd_wheel(*sys.argv[2:7])
    elif cmd == "click":
        out = cmd_click(sys.argv[2], sys.argv[3])
    elif cmd == "move":
        out = cmd_move(sys.argv[2], sys.argv[3])
    elif cmd == "client":
        out = _client_origin(int(sys.argv[2]))
    else:
        out = {"error": "unknown command %r" % cmd}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
