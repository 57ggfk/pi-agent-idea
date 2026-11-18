Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class EW2 {
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static List<string> Dump(IntPtr parent) {
    var outp = new List<string>();
    EnumChildWindows(parent, (h, l) => {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(256); GetClassName(h, sb, 256);
        RECT r; GetWindowRect(h, out r);
        int w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (w > 150 && ht > 150) outp.Add(sb.ToString() + " rect=" + r.Left + "," + r.Top + " " + w + "x" + ht);
      }
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
'@
$p = Get-Process | Where-Object { $_.MainWindowTitle -match "pi-project" } | Select-Object -First 1
[EW2]::Dump($p.MainWindowHandle) | ForEach-Object { Write-Output $_ }
Write-Output "---main window---"
Write-Output ($p.MainWindowTitle + " handle-based rect above")
