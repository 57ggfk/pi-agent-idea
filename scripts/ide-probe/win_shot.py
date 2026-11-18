"""Capture the whole desktop to a 32-bit BMP without extra pip packages.

Only used by the scroll probes to locate the OSR browser on screen (an
off-screen-rendered JCEF component has no child HWND, so Win32 cannot tell us
where the page is). ViewImage reads BMP directly.
"""
import ctypes
import ctypes.wintypes as wt
import struct
import sys

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
user32.SetProcessDPIAware()


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def main(path, w=1920, h=1080):
    w, h = int(w), int(h)
    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    gdi32.BitBlt(mem, 0, 0, w, h, hdc, 0, 0, 0x00CC0020)  # SRCCOPY

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h  # top-down
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0

    stride = w * 4
    buf = ctypes.create_string_buffer(stride * h)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)

    header = struct.pack("<2sIHHI", b"BM", 14 + 40 + len(buf), 0, 0, 14 + 40)
    info = struct.pack("<IiiHHIIiiII", 40, w, -h, 1, 32, 0, len(buf), 2835, 2835, 0, 0)
    with open(path, "wb") as f:
        f.write(header)
        f.write(info)
        f.write(buf.raw)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)
    print(path)


if __name__ == "__main__":
    main(sys.argv[1], *(sys.argv[2:4] or [1920, 1080]))
