# Reports which window is in front, one line per change:
#   ProcessName|ProcessId|x|y|width|height
# Coordinates are physical pixels of the window's content area.
# Reads only window positions. Exits when the app that started it exits.
param([int]$ParentId)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct NativePoint { public int X; public int Y; }
public struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class ForegroundWindow {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out NativeRect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref NativePoint point);
}
"@

[void][ForegroundWindow]::SetProcessDPIAware()
$parent = $null
if ($ParentId -gt 0) { $parent = Get-Process -Id $ParentId -ErrorAction SilentlyContinue }

$last = ''
$names = @{}
$tick = 0
while ($true) {
  $tick++
  if ($parent -and ($tick % 10 -eq 0) -and $parent.HasExited) { exit }

  $hwnd = [ForegroundWindow]::GetForegroundWindow()
  $line = 'none|0|0|0|0|0'
  if ($hwnd -ne [IntPtr]::Zero) {
    $procId = [uint32]0
    [void][ForegroundWindow]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    $key = [int]$procId
    if (-not $names.ContainsKey($key)) {
      try { $names[$key] = (Get-Process -Id $key -ErrorAction Stop).ProcessName } catch { $names[$key] = 'unknown' }
    }
    $rect = New-Object NativeRect
    $point = New-Object NativePoint
    if ([ForegroundWindow]::GetClientRect($hwnd, [ref]$rect) -and [ForegroundWindow]::ClientToScreen($hwnd, [ref]$point)) {
      $line = '{0}|{1}|{2}|{3}|{4}|{5}' -f $names[$key], $key, $point.X, $point.Y, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
    }
  }

  if ($line -ne $last) {
    $last = $line
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 150
}
