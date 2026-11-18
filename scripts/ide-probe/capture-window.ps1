# Capture the sandbox IDE window (title contains 'pi-project') to PNG.
# PrintWindow works even when the window is partially covered.
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$procs = Get-Process | Where-Object { $_.MainWindowTitle -match "pi-project" } | Select-Object -First 3
if (-not $procs) { Write-Output "NO WINDOW with pi-project"; Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { Write-Output ("  visible: " + $_.MainWindowTitle) } | Select-Object -First 10; exit 1 }

foreach ($p in $procs) {
  $h = $p.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { continue }
  $r = New-Object WinCap+RECT
  [WinCap]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -le 0 -or $ht -le 0) { continue }
  $bmp = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  # PW_RENDERFULLCONTENT=2 captures DirectComposition (JCEF) content too
  [WinCap]::PrintWindow($h, $dc, 2) | Out-Null
  $g.ReleaseHdc($dc); $g.Dispose()
  $out = "D:/code/probe-042/sandbox-window.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("SAVED " + $out + " " + $w + "x" + $ht + " title=" + $p.MainWindowTitle)
  break
}
