# GUI ops against the sandbox IDE window (title contains 'pi-project').
# Usage: powershell -File gui-ops.ps1 <command> [args]
#   foreground                       - bring window to front
#   rect                             - print window rect
#   click <winx> <winy>              - click at window-local coords
#   type <text>                      - SendKeys text (window must be foreground+focused)
#   enter                            - SendKeys Enter
#   paste                            - SendKeys Ctrl+V (clipboard pre-set)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GuiOps {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$shell = New-Object -ComObject WScript.Shell

function Get-SandboxWindow {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -match "pi-project" } | Select-Object -First 1
  if (-not $p) { Write-Output "ERR no window"; exit 1 }
  return $p.MainWindowHandle
}

$cmd = $args[0]
$h = Get-SandboxWindow
$r = New-Object GuiOps+RECT
[GuiOps]::GetWindowRect($h, [ref]$r) | Out-Null

switch ($cmd) {
  "foreground" {
    $shell.AppActivate($p.Id) | Out-Null
    [GuiOps]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 300
    Write-Output ("FOREGROUND rect=" + $r.Left + "," + $r.Top + " " + ($r.Right-$r.Left) + "x" + ($r.Bottom-$r.Top))
  }
  "rect" { Write-Output ("RECT " + $r.Left + "," + $r.Top + " " + ($r.Right-$r.Left) + "x" + ($r.Bottom-$r.Top)) }
  "click" {
    $wx = [int]$args[1]; $wy = [int]$args[2]
    $sx = $r.Left + $wx; $sy = $r.Top + $wy
    [GuiOps]::SetCursorPos($sx, $sy) | Out-Null
    Start-Sleep -Milliseconds 120
    [GuiOps]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)  # down
    [GuiOps]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)  # up
    Start-Sleep -Milliseconds 200
    Write-Output ("CLICKED screen=" + $sx + "," + $sy)
  }
  "type" { $shell.SendKeys($args[1]); Write-Output "TYPED" }
  "enter" { $shell.SendKeys("{ENTER}"); Write-Output "ENTER" }
  "paste" { $shell.SendKeys("^v"); Write-Output "PASTED" }
  default { Write-Output "unknown command" }
}
