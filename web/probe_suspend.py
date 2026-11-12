"""Suspend / resume a Windows process (used to fake a hung pi for spec 026).

    python probe_suspend.py <pid> suspend|resume

NtSuspendProcess is what Process Explorer's "Suspend" does; the matching resume
is symmetric, so a suspend/resume pair leaves the target running as before.
"""
import ctypes
import sys

PROCESS_SUSPEND_RESUME = 0x0800
PROCESS_QUERY_INFORMATION = 0x0400


def open_proc(pid: int):
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_QUERY_INFORMATION, False, pid)
    if not h:
        raise SystemExit(f"OpenProcess failed for pid {pid} (err={ctypes.get_last_error()})")
    return h


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[2] not in ("suspend", "resume"):
        raise SystemExit(__doc__)
    pid = int(sys.argv[1])
    h = open_proc(pid)
    ntdll = ctypes.windll.ntdll
    fn = ntdll.NtSuspendProcess if sys.argv[2] == "suspend" else ntdll.NtResumeProcess
    status = fn(h)
    ctypes.windll.kernel32.CloseHandle(h)
    print(f"{sys.argv[2]} pid={pid} status=0x{status & 0xFFFFFFFF:08X}")


if __name__ == "__main__":
    main()
