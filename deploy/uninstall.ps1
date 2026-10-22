<#
deploy\uninstall.ps1 - remove everything install.ps1 put down.

Removes, in order:
  1. the COM registration       via the DLL's own DllUnregisterServer
  2. the registry key           belt-and-braces delete, in case the DLL is gone
  3. the build log              the one file the DLL writes beside itself

Preserves:
  * the package directory itself (delete the folder to finish removal)
  * node_modules (same)
  * any SONAR setting, project, or content
  * the optional loopMIDI application, driver and ports (they may be shared)
  * MIDI input configuration in TTSSEQ.INI, CAL scripts and INI backups

The installer can enable a MIDI input and install loopMIDI. This uninstaller
removes the adapter registration and deployed DLL, but does not reverse those
shared changes. Remove an unwanted MIDI input through SONAR Preferences; remove
loopMIDI separately through Windows Installed Apps if no other application uses it.

Usage:
  powershell -ExecutionPolicy Bypass -File deploy\uninstall.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
$Clsid = '{7C4A9B21-3D5E-4F8A-9E21-6B4D380A7C51}'
$failures = 0

Write-Host ""
Write-Host "cakewalkmcp uninstall" -ForegroundColor White

# A running SONAR holds the DLL loaded; unregistering under it leaves the
# in-memory copy alive until exit, which is fine, but warn so the user knows
# why the surface keeps working until restart.
$sonar = Get-Process Sonar -ErrorAction SilentlyContinue
if ($sonar) {
  Write-Host "  note: SONAR is running - restart it after uninstall to fully unload the plugin" -ForegroundColor Yellow
}

Write-Host "  [1] COM unregister"
$dll = Join-Path $Root 'native\surface\build\cw_surface.dll'
if (Test-Path $dll) {
  $p = Start-Process regsvr32.exe -ArgumentList @('/u', '/s', "`"$dll`"") -Wait -PassThru
  Write-Host ("      regsvr32 /u exit {0}" -f $p.ExitCode)
  # It prints the code but the old version never acted on it: a failed
  # unregistration still ended with "uninstalled." and exit 0.
  if ($p.ExitCode -ne 0) { $failures++ }
} else {
  Write-Host "      DLL already gone, skipping"
}

Write-Host "  [2] registry key"
$key = "HKCU:\SOFTWARE\Classes\CLSID\$Clsid"
if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Host "      removed $key" }
else { Write-Host "      already absent" }
$surf = "HKCU:\SOFTWARE\Classes\CakewalkControlSurfaces\$Clsid"
if (Test-Path $surf) {
  try { Remove-Item $surf -Recurse -Force -ErrorAction Stop; Write-Host "      removed $surf" }
  catch { Write-Host ("      could not remove {0}: {1}" -f $surf, $_.Exception.Message) -ForegroundColor Yellow; $failures++ }
}

Write-Host "  [3] build log"
$log = Join-Path $Root 'native\surface\build\cw_surface.log'
if (Test-Path $log) { Remove-Item $log -Force; Write-Host "      removed log" }

# install.ps1 -WithSurface also COPIES the DLL into SONAR's Shared Surfaces
# folder (a second discovery path). The old uninstall never removed it, so the
# plugin stayed visible after "uninstalled." - measured on this host.
Write-Host "  [4] Shared Surfaces copy"
$sharedKey = 'HKLM:\SOFTWARE\Cakewalk Music Software\Shared Surfaces'
$sharedDir = $null
if (Test-Path $sharedKey) {
  $sharedDir = (Get-ItemProperty $sharedKey -Name 'InstallDirectory' -ErrorAction SilentlyContinue).InstallDirectory
}
if ($sharedDir) {
  $sharedTarget = Join-Path $sharedDir 'cw_surface.dll'
  if (Test-Path -LiteralPath $sharedTarget) {
    try { Remove-Item -LiteralPath $sharedTarget -Force -ErrorAction Stop; Write-Host "      removed $sharedTarget" }
    catch { Write-Host ("      could not remove {0}: {1}" -f $sharedTarget, $_.Exception.Message) -ForegroundColor Yellow; $failures++ }
  } else { Write-Host "      not present" }
} else { Write-Host "      Shared Surfaces folder not registered, nothing to remove" }

# Prove the removal rather than assert it: after this, SONAR on next launch
# cannot see the surface, and the merged HKCR view answers nothing for the CLSID.
Write-Host "  [5] verify"
$gone = -not (Test-Path "HKCU:\SOFTWARE\Classes\CLSID\$Clsid")
Write-Host ("      registry clean: {0}" -f $gone)
if (-not $gone) { $failures++ }

Write-Host ""
if ($failures -gt 0) {
  Write-Host ("uninstalled with {0} unfinished step(s); see above." -f $failures) -ForegroundColor Yellow
  Write-Host "The package folder remains - delete it to finish."
  exit 1
}
Write-Host "uninstalled. The package folder remains - delete it to finish."
Write-Host ""
exit 0
