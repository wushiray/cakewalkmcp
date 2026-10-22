# install.ps1 — make SONAR discover the cw_surface control-surface plugin.
#
# HOW SONAR FINDS SURFACES (measured, and it corrected an earlier wrong guess)
#
# The earlier assumption was a "CakewalkControlSurfaces" key under
# HKLM\SOFTWARE\Classes. That key does not exist on this machine — nothing
# enumerates it. What actually exists:
#
#   HKCR\CLSID\{CLSID}\InprocServer32   -> the DLL path        (COM registration)
#   HKLM\...\Cakewalk Music Software\Shared Surfaces\InstallDirectory
#                                       -> D:\CAKEWALK\Shared Surfaces
#                                          (the folder SONAR scans)
#
# GenericSurface.dll is registered in exactly the first place:
#   {404C9315-693D-4715-A326-143A992FA784} -> D:\CAKEWALK\Shared Surfaces\GenericSurface.dll
#
# So there are two viable install paths, and this script does the first and
# offers the second:
#
#   1. COMPONENT REGISTRATION (default) — the DLL writes its own
#      HKCR\CLSID\{...}\InprocServer32 when regsvr32 calls DllRegisterServer.
#      From a non-elevated shell that lands in HKCU\SOFTWARE\Classes, which is
#      part of the merged HKCR view, so no UAC prompt and nothing machine-wide.
#      This is the mechanism SONAR's own plugins use, so it is the one least
#      likely to surprise the loader.
#
#   2. FOLDER COPY (-CopyToShared) — drop the DLL into the folder named by
#      InstallDirectory, the way the shipped surfaces sit there. One file, one
#      delete to undo.
#
# Neither touches licensing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -CopyToShared
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Unregister

param(
    [switch]$Unregister,
    [switch]$CopyToShared
)

$ErrorActionPreference = 'Stop'

$Clsid = '{7C4A9B21-3D5E-4F8A-9E21-6B4D380A7C51}'
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dll   = Join-Path $here 'build\cw_surface.dll'

function Get-SharedSurfacesDir {
    $key = 'HKLM:\SOFTWARE\Cakewalk Music Software\Shared Surfaces'
    if (Test-Path $key) {
        $v = (Get-ItemProperty -Path $key -Name 'InstallDirectory' -ErrorAction SilentlyContinue)
        if ($v -and $v.InstallDirectory) { return $v.InstallDirectory }
    }
    return $null
}

if ($Unregister) {
    # Remove the COM registration. regsvr32 /u calls DllUnregisterServer, which
    # drops the HKCU\SOFTWARE\Classes\CLSID\{...} subtree.
    if (Test-Path $dll) {
        Write-Host "Calling regsvr32 /u ..."
        $p = Start-Process -FilePath 'regsvr32.exe' -ArgumentList @('/u','/s',"`"$dll`"") -Wait -PassThru
        Write-Host "  regsvr32 exit=$($p.ExitCode)"
    }
    # Belt and braces: remove the key even if the DLL is gone.
    $k = "HKCU:\SOFTWARE\Classes\CLSID\$Clsid"
    if (Test-Path $k) { Remove-Item $k -Recurse -Force; Write-Host "Removed $k" }

    # And the folder copy, if there is one.
    $shared = Get-SharedSurfacesDir
    if ($shared) {
        $target = Join-Path $shared 'cw_surface.dll'
        if (Test-Path $target) { Remove-Item $target -Force; Write-Host "Removed $target" }
    }
    Write-Host ""
    Write-Host "Unregistered. Restart SONAR for it to stop loading the plugin." -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path $dll)) {
    Write-Host "DLL not found at $dll" -ForegroundColor Red
    Write-Host "Run build.cmd first." -ForegroundColor Red
    exit 1
}
$dllFull = (Resolve-Path $dll).Path

Write-Host "Installing Cakewalk MCP Surface Bridge" -ForegroundColor Cyan
Write-Host "  clsid : $Clsid"
Write-Host "  dll   : $dllFull"
Write-Host ""

if ($CopyToShared) {
    $shared = Get-SharedSurfacesDir
    if (-not $shared) {
        Write-Host "Could not read InstallDirectory from the Shared Surfaces key." -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path $shared)) {
        Write-Host "Shared Surfaces directory does not exist: $shared" -ForegroundColor Red
        exit 1
    }
    $target = Join-Path $shared 'cw_surface.dll'
    Copy-Item -Path $dllFull -Destination $target -Force
    Write-Host "Copied to $target" -ForegroundColor Green
    Write-Host ""
    Write-Host "This is the folder SONAR scans, so the plugin will appear alongside" -ForegroundColor Green
    Write-Host "GenericSurface and MackieControl." -ForegroundColor Green
} else {
    # /s = silent (no message box). DllRegisterServer writes HKCU\SOFTWARE\Classes,
    # which needs no elevation and is visible through the merged HKCR view.
    Write-Host "Calling regsvr32 (writes HKCU, no elevation) ..."
    $p = Start-Process -FilePath 'regsvr32.exe' -ArgumentList @('/s',"`"$dllFull`"") -Wait -PassThru
    Write-Host "  regsvr32 exit=$($p.ExitCode)"

    $inproc = "HKCU:\SOFTWARE\Classes\CLSID\$Clsid\InProcServer32"
    if (Test-Path $inproc) {
        $v = (Get-ItemProperty -Path $inproc -Name '(default)').'(default)'
        Write-Host "  registered -> $v" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: InProcServer32 not found after regsvr32." -ForegroundColor Yellow
        Write-Host "  regsvr32 may have failed. Try: install.ps1 -CopyToShared" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Next steps" -ForegroundColor Cyan
Write-Host "  1. Start SONAR."
Write-Host "  2. Open  偏好设置 > MIDI > 控制面板  (Preferences > MIDI > Control Surfaces)."
Write-Host "  3. Look for 'Cakewalk MCP Surface Bridge' and add it."
Write-Host "  4. Check the bridge is live:  node ..\..\tools\surface-probe.mjs"
Write-Host ""
Write-Host "To undo:  powershell -ExecutionPolicy Bypass -File install.ps1 -Unregister" -ForegroundColor Yellow
