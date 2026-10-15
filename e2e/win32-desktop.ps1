param(
  [Parameter(Mandatory=$true)][ValidateSet('frame', 'capture', 'print', 'keys', 'click', 'rclick', 'menukeys', 'list')][string]$Mode,
  [string]$Hwnd = '0',
  [string]$Combo = '',
  [string]$Out = '',
  [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0,
  [int]$ProcId = 0
)
# The Windows desktop as a user meets it, for e2e/desktop-shell.win32.spec.ts:
# real keystrokes and clicks through the OS input queue (Playwright's CDP input
# never reaches the window frame, the menu accelerators or the drag regions),
# and pixels as the screen shows them, native title bar included.
#
# keys, click and rclick only act when the sandboxed window is the foreground
# window at that instant, and exit 3 otherwise: a chord like Ctrl+W must never
# land in another application. click and rclick also require the window at the
# point (WindowFromPoint, its root) to be the target, since a click reaches
# whatever is there, and exit 3 otherwise. menukeys sends keys (here "+" is a
# sequence, not a chord) to an open popup menu, -Hwnd, of the process -ProcId:
# every key name must be known (exit 2 otherwise, before any is sent), and the
# foreground window must be that process's own before each key. (Electron draws its menus on
# Windows with Chromium's views, in windows of class Chrome_WidgetWin_1, not
# the system's #32768.)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class D {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  /** The top-level window at a screen point (GA_ROOT), the one a click there reaches. */
  public static IntPtr RootAt(int x, int y) { var p = new POINT(); p.X = x; p.Y = y; return GetAncestor(WindowFromPoint(p), 2); }
  public static List<string> List(uint pid) {
    var r = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64);
        var t = new System.Text.StringBuilder(256); GetWindowText(h, t, 256);
        RECT rc; GetWindowRect(h, out rc);
        r.Add(h.ToInt64() + "|" + c + "|" + t + "|" + rc.L + "|" + rc.T + "|" + (rc.R - rc.L) + "|" + (rc.B - rc.T));
      } return true; }, IntPtr.Zero);
    return r;
  }
}
"@
[D]::SetProcessDPIAware() | Out-Null
$target = [IntPtr]::new([Int64]$Hwnd)

function Save-Rect($x, $y, $w, $hh, $path) {
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $hh))
  $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

function Take-Foreground {
  $fg = [D]::GetForegroundWindow()
  if ($fg -ne $target) {
    $a = [D]::GetCurrentThreadId(); $b = [D]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    [D]::AttachThreadInput($a, $b, $true) | Out-Null
    [D]::SetForegroundWindow($target) | Out-Null; [D]::BringWindowToTop($target) | Out-Null
    [D]::AttachThreadInput($a, $b, $false) | Out-Null
    Start-Sleep -Milliseconds 300
  }
  if ([D]::GetForegroundWindow() -ne $target) { 'NOT-FOREGROUND'; exit 3 }
}

# A click lands on whatever window is at the point, foreground or not: a window
# kept on top by another program, or a point off the target, would take it.
function Assert-TargetAt($x, $y) {
  if ([D]::RootAt($x, $y) -ne $target) { 'NOT-TARGET-AT-POINT'; exit 3 }
}

# The foreground window belongs to the process -ProcId, asked before every key.
function Assert-ForegroundProcess {
  $fgPid = [uint32]0
  [D]::GetWindowThreadProcessId([D]::GetForegroundWindow(), [ref]$fgPid) | Out-Null
  if ($fgPid -ne [uint32]$ProcId) { 'NOT-FOREGROUND-PROCESS'; exit 3 }
}

switch ($Mode) {
  'frame' {
    # DWMWA_EXTENDED_FRAME_BOUNDS: the visible window, without the invisible resize borders.
    $r = New-Object D+RECT
    [D]::DwmGetWindowAttribute($target, 9, [ref]$r, 16) | Out-Null
    "{""x"":$($r.L),""y"":$($r.T),""width"":$($r.R - $r.L),""height"":$($r.B - $r.T)}"
  }
  'capture' { Save-Rect $X $Y $W $H $Out; "saved $Out" }
  'print' {
    $wr = New-Object D+RECT
    [D]::GetWindowRect($target, [ref]$wr) | Out-Null
    $bmp = New-Object System.Drawing.Bitmap ($wr.R - $wr.L), ($wr.B - $wr.T)
    $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
    [D]::PrintWindow($target, $hdc, 2) | Out-Null
    $g.ReleaseHdc($hdc); $g.Dispose(); $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    "saved $Out"
  }
  'keys' {
    $map = @{ ctrl = 0x11; shift = 0x10; alt = 0x12; enter = 0x0D; esc = 0x1B; f4 = 0x73; '=' = 0xBB; '-' = 0xBD }
    $keys = @($Combo.ToLower().Split('+') | ForEach-Object {
      if ($map.ContainsKey($_)) { [byte]$map[$_] } else { [byte][char]$_.ToUpper() }
    })
    Take-Foreground
    # With its scan code, as a keyboard sends it: Chromium reads KeyboardEvent.code from it.
    foreach ($k in $keys) { [D]::keybd_event($k, [byte][D]::MapVirtualKey($k, 0), 0, [UIntPtr]::Zero) }
    [array]::Reverse($keys)
    foreach ($k in $keys) { [D]::keybd_event($k, [byte][D]::MapVirtualKey($k, 0), 2, [UIntPtr]::Zero) }
    "SENT $Combo"
  }
  'click' {
    Take-Foreground
    Assert-TargetAt $X $Y
    $p = New-Object D+POINT
    [D]::GetCursorPos([ref]$p) | Out-Null
    [D]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 80
    [D]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
    [D]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [D]::SetCursorPos($p.X, $p.Y) | Out-Null
    "CLICKED $X,$Y"
  }
  'rclick' {
    Take-Foreground
    Assert-TargetAt $X $Y
    $p = New-Object D+POINT
    [D]::GetCursorPos([ref]$p) | Out-Null
    [D]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 80
    # RIGHTDOWN, RIGHTUP. The cursor stays where the menu opened, under it.
    [D]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
    [D]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    "RCLICKED $X,$Y"
  }
  'menukeys' {
    # Keys for an open menu: taking the foreground (Take-Foreground) would close
    # it, so instead the menu -Hwnd must be up and the foreground window must be
    # the process -ProcId's own, which is where the keys then land.
    $map = @{ enter = 0x0D; esc = 0x1B; down = 0x28; up = 0x26 }
    $names = @($Combo.ToLower().Split('+'))
    # Every key named before any is sent: an unknown one would have been sent as 0.
    foreach ($k in $names) { if (-not $map.ContainsKey($k)) { "UNKNOWN-KEY $k"; exit 2 } }
    $open = @([D]::List([uint32]$ProcId) | Where-Object { $_.Split('|')[0] -eq $Hwnd }).Count -gt 0
    if (-not $open) { 'NOT-IN-MENU'; exit 3 }
    foreach ($k in $names) {
      Assert-ForegroundProcess
      $vk = [byte]$map[$k]
      [D]::keybd_event($vk, [byte][D]::MapVirtualKey($vk, 0), 0, [UIntPtr]::Zero)
      [D]::keybd_event($vk, [byte][D]::MapVirtualKey($vk, 0), 2, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 150
    }
    "MENUKEYS $Combo"
  }
  'list' { [D]::List([uint32]$ProcId) }
}
