# Gives the runner's display the size the E2E suite needs, and says what it got.
#
# CI's windows-latest starts with a 1024x768 display. The desktop-shell specs
# capture and click the real screen, and their 1200x800 window ran off it: the
# caption buttons were read as black. The fixture fails a
# spec whose window is not on the screen's work area; this makes it fit.
#
# ChangeDisplaySettings on the current display, for this session only (flags
# 0), then Set-DisplayResolution where Windows Server has it, if the first is
# refused. The step fails, naming every mode the display offers, when the
# display is still smaller than asked: a run that cannot capture the window
# would only fail later and less clearly.
#
# -List only reads: the current mode and the modes offered, nothing changed.
param(
  [int]$Width = 1920,
  [int]$Height = 1080,
  [switch]$List
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TarsDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);

  const int ENUM_CURRENT_SETTINGS = -1;
  const int DM_PELSWIDTH = 0x80000;
  const int DM_PELSHEIGHT = 0x100000;

  static DEVMODE Blank() {
    DEVMODE dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    return dm;
  }

  public static int[] Current() {
    DEVMODE dm = Blank();
    if (!EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref dm)) throw new Exception("EnumDisplaySettings could not read the current mode");
    return new int[] { dm.dmPelsWidth, dm.dmPelsHeight };
  }

  public static string[] Modes() {
    HashSet<string> seen = new HashSet<string>();
    List<string> modes = new List<string>();
    DEVMODE dm = Blank();
    for (int i = 0; EnumDisplaySettings(null, i, ref dm); i++) {
      string mode = dm.dmPelsWidth + "x" + dm.dmPelsHeight;
      if (seen.Add(mode)) modes.Add(mode);
      dm = Blank();
    }
    return modes.ToArray();
  }

  // DISP_CHANGE_SUCCESSFUL is 0; anything else is Windows's reason.
  public static int Set(int width, int height) {
    DEVMODE dm = Blank();
    if (!EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref dm)) throw new Exception("EnumDisplaySettings could not read the current mode");
    dm.dmPelsWidth = width;
    dm.dmPelsHeight = height;
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    return ChangeDisplaySettings(ref dm, 0);
  }
}
'@

$before = [TarsDisplay]::Current()
$modes = [TarsDisplay]::Modes() -join ', '
Write-Output "display: $($before[0])x$($before[1]); modes offered: $modes"
if ($List) { exit 0 }

if ($before[0] -ge $Width -and $before[1] -ge $Height) {
  Write-Output "display: already at least ${Width}x${Height}"
  exit 0
}

$code = [TarsDisplay]::Set($Width, $Height)
Write-Output "display: ChangeDisplaySettings ${Width}x${Height} answered $code"
if ($code -ne 0 -and (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue)) {
  Set-DisplayResolution -Width $Width -Height $Height -Force
  Write-Output 'display: Set-DisplayResolution ran'
}

$after = [TarsDisplay]::Current()
Write-Output "display: now $($after[0])x$($after[1])"
if ($after[0] -lt $Width -or $after[1] -lt $Height) {
  Write-Error "the display is $($after[0])x$($after[1]), smaller than ${Width}x${Height}; modes offered: $modes"
  exit 1
}
