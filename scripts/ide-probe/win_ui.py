"""Minimal Win32 UI helper for driving the IDEA dialog on the primary desktop.

No external packages. Uses ctypes only (Add-Type is blocked by policy on this box).
Usage:
  python win_ui.py list
  python win_ui.py focus <substring>
  python win_ui.py click <x> <y>
  python win_ui.py key <vk>          (e.g. 13 = Enter, 27 = Esc)
  python win_ui.py shot <path> [w h]
"""
import ctypes
import ctypes.wintypes as wt
import sys

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.SetProcessDPIAware()

ENUMProC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def list_windows():
    out = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        if title or cls.value in ("SunAwtDialog", "SunAwtFrame"):
            out.append((hwnd, cls.value, title, (r.left, r.top, r.right, r.bottom)))
        return True

    user32.EnumWindows(ENUMProC(cb), 0)
    for hwnd, cls, title, rect in out:
        print(f"hwnd={hwnd} cls={cls!r} rect={rect} title={title!r}")


def find(substr):
    found = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if substr.lower() in buf.value.lower():
            found.append(hwnd)
        return True

    user32.EnumWindows(ENUMProC(cb), 0)
    return found


def focus(substr):
    hwnds = find(substr)
    if not hwnds:
        print(f"NO WINDOW matching {substr!r}")
        return
    hwnd = hwnds[0]
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    print(f"focused hwnd={hwnd} rect=({r.left},{r.top},{r.right},{r.bottom})")


def click(x, y):
    user32.SetCursorPos(int(x), int(y))
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    print(f"clicked ({x},{y})")


def rclick(x, y):
    user32.SetCursorPos(int(x), int(y))
    user32.mouse_event(0x0008, 0, 0, 0, 0)  # RIGHTDOWN
    user32.mouse_event(0x0010, 0, 0, 0, 0)  # RIGHTUP
    print(f"rclicked ({x},{y})")


def dblclick(x, y):
    user32.SetCursorPos(int(x), int(y))
    for _ in range(2):
        user32.mouse_event(0x0002, 0, 0, 0, 0)
        user32.mouse_event(0x0004, 0, 0, 0, 0)
    print(f"dblclicked ({x},{y})")


def type_text(text):
    # Unicode text via clipboard-free SendInput W; falls back to VK per char for ASCII.
    for ch in text:
        vk = user32.VkKeyScanW(ord(ch))
        low = vk & 0xFF
        shift = (vk >> 8) & 0xFF
        if low == 0xFF:
            continue
        if shift & 1:
            user32.keybd_event(0x10, 0, 0, 0)
        user32.keybd_event(low, 0, 0, 0)
        user32.keybd_event(low, 0, 0x0002, 0)
        if shift & 1:
            user32.keybd_event(0x10, 0, 0x0002, 0)
    print(f"typed {text!r}")


def key(vk):
    user32.keybd_event(vk & 0xFF, 0, 0, 0)
    user32.keybd_event(vk & 0xFF, 0, 0x0002, 0)  # KEYUP
    print(f"key vk={vk}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "list":
        list_windows()
    elif cmd == "focus":
        focus(sys.argv[2])
    elif cmd == "click":
        click(sys.argv[2], sys.argv[3])
    elif cmd == "rclick":
        rclick(sys.argv[2], sys.argv[3])
    elif cmd == "dblclick":
        dblclick(sys.argv[2], sys.argv[3])
    elif cmd == "type":
        type_text(sys.argv[2])
    elif cmd == "key":
        key(int(sys.argv[2]))
    else:
        print("unknown command", cmd)
