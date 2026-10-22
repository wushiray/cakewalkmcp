Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Can a PLAIN UIA client see SONAR's track controls?
#
# The adapter's own notes recorded that it cannot — "a plain UIA client sees 2
# elements" — which is why track-strip control has been out of reach for the MCP
# server and only a computer-use runtime could do it. This tests that claim
# directly, and also tests the screen-reader flag, since an app that gates its
# accessibility provider on SPI_GETSCREENREADER would explain the difference.
Add-Type @"
using System.Runtime.InteropServices;
public class SR {
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, ref int c, uint d);
  public const uint GET = 0x0046, SET = 0x0047;
  public static bool IsOn() { int v = 0; SystemParametersInfo(GET, 0, ref v, 0); return v != 0; }
  public static void On()  { int v = 1; SystemParametersInfo(SET, 0, ref v, 0); }
}
"@

$p = Get-Process Sonar -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Write-Output "SONAR not running"; exit 1 }
Write-Output ("screenReaderFlag before = " + [SR]::IsOn())
[SR]::On()
Write-Output ("screenReaderFlag after  = " + [SR]::IsOn())

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output "no top-level window for pid"; exit 1 }
Write-Output ("window: " + $win.Current.Name + "  class=" + $win.Current.ClassName)

$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition)
Write-Output ("plain-UIA descendants = " + $all.Count)

$named = 0
foreach ($e in $all) {
  $n = $e.Current.Name
  if ($n -and $n -match 'Track') {
    $named++
    if ($named -le 8) {
      $r = $e.Current.BoundingRectangle
      Write-Output ("  '" + $n + "'  controlType=" + $e.Current.ControlType.ProgrammaticName +
                    "  rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
    }
  }
}
Write-Output ("elements whose name mentions Track: " + $named)
