<#
deploy\install.ps1 — one-command setup for the cakewalkmcp adapter.

WHAT IT DOES, IN ORDER, EACH STEP REPORTED:

  1. checks prerequisites        node >= 18.19.0, SONAR installation found
  2. npm install (if needed)     only when node_modules is missing or stale
  3. control surface DLL         SKIPPED by default; -WithSurface opts in
  4. virtual MIDI cable          finds loopMIDI wherever it is installed,
                                 installs it if missing, starts it, checks that a
                                 usable port exists, and ENABLES that port in
                                 SONAR's TTSSEQ.INI (only while SONAR is closed —
                                 a running instance would overwrite it)
  4b. SONAR sign-in state        reports whether SONAR has been signed in, because
                                 an unactivated SONAR does not expose the
                                 track-strip controls the click tools need
  5. runs cw_doctor              the health check, so "installed" means
                                 "verified", not "copied"

AFTER THIS SCRIPT THERE IS NOTHING ELSE TO DO except the two interactions no
installer can perform: accepting the UAC prompt that installs loopMIDI's driver,
and signing in to SONAR once. No per-session step, no manual Preferences visit,
no computer-use runtime needed. Everything else rests on paths SONAR exercises on
its own — menu commands, the accessibility tree, a live MIDI cable, and .mid
files read at project load.

THE CONTROL SURFACE DLL IS NOW OPT-IN (-WithSurface) AND NOT INSTALLED BY
DEFAULT. It used to be step 3/4/4b of the default run. It was demoted after the
mechanism was finally established at function level:

  * SONAR exports CCtrlSurface::PersistSurfaces — it WRITES ctrlsurface.dat —
    but no LoadSurfaces / RestoreSurfaces / InitSurfaces symbol exists anywhere
    in Sonar.exe. Measured consequence: the file held this adapter's CLSID at
    00:09, SONAR started at 00:16, and the process module list afterwards did
    NOT contain cw_surface.dll.
  * So the surface is only ever instantiated at the moment the user presses OK
    in 参数设置 > MIDI > 控制界面, and never restored afterwards. Every fresh
    SONAR start therefore needs that manual step again — the opposite of
    one-click, and unfixable from outside without patching the host, which this
    project does not do.
  * Nothing depends on it any more. Exactly one tool (cw_surface_set) needed it
    to write, and every one of those writes now has a file-based path: CC7/CC10
    baked into a .mid and imported is verified end to end (see README), mute and
    rename and routing go through CAL, the three toggles go through a real click
    on the track strip. -WithSurface exists for diagnostics and experiments, not
    for capability.

WHAT IT DELIBERATELY DOES NOT DO:

  * No HKLM REGISTRY writes and no elevation for the adapter itself: it registers
    under HKCU\SOFTWARE\Classes and writes nothing machine-wide.
    Two documented exceptions, both visible in the run:
      - installing a MISSING loopMIDI runs the vendor's driver installer, which
        shows one UAC prompt. Pass -LoopMidi skip to avoid it.
      - -WithSurface copies cw_surface.dll into SONAR's Shared Surfaces folder.
  * No licence interaction of any kind.
  * It does not hand-write MaxInPort. That key holds the HIGHEST enabled device
    index, so -1 is the pristine "nothing selected" state and not "all devices";
    guessing at it from an installer is how a working setup gets broken.
    It DOES enable a MIDI input through lib\midi-config.js, which renumbers the
    section densely and writes exactly one Max key — and only while SONAR is
    closed, with a .bak beside the original.

Usage:
  powershell -ExecutionPolicy Bypass -File deploy\install.ps1
  powershell -ExecutionPolicy Bypass -File deploy\install.ps1 -SkipDoctor
  powershell -ExecutionPolicy Bypass -File deploy\install.ps1 -WithSurface
#>
[CmdletBinding()]
param(
  [switch]$SkipDoctor,
  [switch]$WithSurface,
  # auto: install loopMIDI via winget (or the official package) when missing.
  # skip: report only, never touch the machine.
  [ValidateSet('auto', 'skip')][string]$LoopMidi = 'auto'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'install-lock.ps1')
$installerLock = Enter-InstallerLock
try {
# Console output in UTF-8, explicitly.
#
# Without this the script's Chinese text is encoded with the console's current
# code page, and on an English Windows that replaces every CJK character with
# '?' — measured in the Windows test VM, where the deploy printed rows of
# question marks while the same strings were perfect in the log file. Setting the
# encoding here makes the output independent of how the console was started.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$script:ownedLoopMidi = $null
$script:midiEnabledByInstaller = $false
$script:sonarNotSignedIn = $false
$script:sonarLicenceUnknown = $false

function Step($n, $msg) { Write-Host ("  [{0}] {1}" -f $n, $msg) -ForegroundColor Cyan }
function Ok($msg)       { Write-Host ("      ok: {0}" -f $msg) -ForegroundColor Green }
function Warn($msg)     { Write-Host ("      !!  {0}" -f $msg) -ForegroundColor Yellow }

Write-Host ""
Write-Host "cakewalkmcp install" -ForegroundColor White
Write-Host ("  root: {0}" -f $Root)
Write-Host ""

# ---- 1. prerequisites -------------------------------------------------------
Step 1 "prerequisites"
# The runtime SHIPPED IN THE PACKAGE comes first.
#
# Node.js is a developer runtime and most musicians' machines do not have it, so
# requiring it made "one-click" untrue: measured on a clean Windows 11 VM, the
# install stopped at this step every time. runtime\node.exe is self-contained
# (93 MB, no install, no admin), so the package now carries its own.
$BundledNode = Join-Path $Root 'runtime\node.exe'
$NodeExe = $null
if (Test-Path -LiteralPath $BundledNode) {
  $NodeExe = $BundledNode
} else {
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { $NodeExe = $onPath.Source }
}
if (-not $NodeExe) {
  $why = "no Node runtime: expected runtime\node.exe inside the package, or node on PATH. "
  $why += "Re-extract the package, or install Node.js >= 18.19.0 from https://nodejs.org"
  throw $why
}
$v = (& $NodeExe --version) -replace '^v', ''
if ([version]$v -lt [version]'18.19.0') { throw "node $v is too old; this adapter needs >= 18.19.0" }
Ok ("node {0}{1}" -f $v, $(if ($NodeExe -eq $BundledNode) { ' (bundled with the package)' } else { ' (from PATH)' }))

$sonar = @(
  "$env:ProgramFiles\Cakewalk\SONAR\Sonar.exe",
  "${env:ProgramFiles(x86)}\Cakewalk\SONAR\Sonar.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sonar) {
  try {
    $discovery = & $NodeExe (Join-Path $Root 'deploy\find-sonar.mjs')
    if ($LASTEXITCODE -eq 0) {
      $found = ($discovery | ConvertFrom-Json).path
      if ($found -and (Test-Path -LiteralPath $found)) { $sonar = $found }
    }
  } catch { Warn 'Additional SONAR path discovery failed; cw_doctor can give more detail.' }
}
$script:sonarRuntimeOk = $true
if ($sonar) { Ok ("SONAR found: {0}" -f $sonar) }
else { Warn "SONAR.exe not found in Program Files — the adapter will still install, but cw_doctor cannot pass until SONAR is installed" }

# "SONAR.exe exists" is NOT "SONAR can run". Measured on a clean Windows 11 VM:
# the registry had a Cakewalk Sonar entry and the exe was on disk, but
# msvcp140.dll / mfc140u.dll were absent, so every launch died with 0xC0000135
# (STATUS_DLL_NOT_FOUND). The installer still printed "installed." and left the
# user with a package that drives an application which cannot start.
#
# These are the DLLs Sonar.exe imports directly (objdump -p also lists
# VCRUNTIME140_1.dll, which was missing from the first version of this check).
# An app-local copy in
# SONAR's own folder counts too: the loader searches there before System32.
if ($sonar) {
  $sys32 = Join-Path $env:WINDIR 'System32'
  $appDir = Split-Path -Parent $sonar
  $missingDlls = @()
  foreach ($dll in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'mfc140u.dll')) {
    $inSys = Test-Path -LiteralPath (Join-Path $sys32 $dll)
    $inApp = Test-Path -LiteralPath (Join-Path $appDir $dll)
    if (-not ($inSys -or $inApp)) { $missingDlls += $dll }
  }
  if ($missingDlls.Count -gt 0) {
    $script:sonarRuntimeOk = $false
    Warn ("SONAR cannot start: its C++ runtime is missing ({0})" -f ($missingDlls -join ', '))
    Write-Host '      SONAR.exe exits immediately with 0xC0000135 (STATUS_DLL_NOT_FOUND), so'
    Write-Host '      every adapter tool that needs SONAR will report it as unreachable.'
    Write-Host '      Fix: install the Microsoft Visual C++ 2015-2022 Redistributable (x64)'
    Write-Host '           https://aka.ms/vs/17/release/vc_redist.x64.exe'
    Write-Host '      Then re-run this installer to re-check.'
  } else {
    Ok 'SONAR C++ runtime present (msvcp140 / vcruntime140 / vcruntime140_1 / mfc140u)'
  }
}

# ---- 2. npm dependencies ----------------------------------------------------
Step 2 "npm dependencies"
# The check is "does the SDK actually load", not "does a directory exist".
#
# Measured: a killed npm install leaves node_modules\@modelcontextprotocol as an
# empty directory, the old Test-Path was satisfied, npm was skipped, and the
# installer still printed "installed." — a deployment that cannot start the
# server but reports success. A dynamic import is the cheapest honest probe.
$depsOk = $false
Push-Location $Root
try {
  # deploy/check-deps.mjs, not an inline import: bare-specifier resolution walks
  # up the tree, so an inline import would pass on a parent project's modules.
  & $NodeExe 'deploy\check-deps.mjs' $Root 2>$null
  $depsOk = ($LASTEXITCODE -eq 0)
} catch { $depsOk = $false } finally { Pop-Location }

if (-not $depsOk) {
  Push-Location $Root
  try {
    # $LASTEXITCODE check, explicit. ErrorActionPreference=Stop does NOT catch a
    # failing native command (the audit simulated npm exit 7 and the old code
    # printed "completed" anyway) — only a check does. npm's stderr is diverted
    # to the transcript, not promoted, for the same reason the gcc build below
    # uses cmd /c.
    #
    # BOUNDED, because npm can hang forever on a black-holed network: measured in
    # the Windows VM, where a run sat in npm for 15+ minutes with no output and no
    # way forward. A blocked registry is not a reason to leave the user staring at
    # a frozen window — it is a reason to fail with the log.
    # Put the runtime's own directory first so a bundled npm.cmd is found even
    # when Node was never installed system-wide.
    $env:PATH = (Split-Path -Parent $NodeExe) + ';' + $env:PATH
    $npmLog = Join-Path $env:TEMP ('npm-install-' + [Guid]::NewGuid().ToString('n').Substring(0, 8) + '.log')
    $npmProc = Start-Process -FilePath 'cmd.exe' `
      -ArgumentList @('/c', "npm install --no-fund --no-audit > `"$npmLog`" 2>&1") `
      -PassThru -WindowStyle Hidden
    if (-not $npmProc.WaitForExit(300000)) {
      & cmd /c "taskkill /T /F /PID $($npmProc.Id) >nul 2>&1"
      Get-Content -LiteralPath $npmLog -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
      # One parenthesised expression: a line starting with '+' is a new statement
      # in PowerShell 5.1, so the old form silently dropped the remedy half.
      $why = "npm install did not finish within 5 minutes and was stopped. The registry is "
      $why += " probably unreachable; the last npm output is above. Ship node_modules/ with the "
      $why += "package to remove this dependency entirely."
      throw $why
    }
    Get-Content -LiteralPath $npmLog -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    if ($npmProc.ExitCode -eq 0) {
      # One log per attempt accumulated in %TEMP% forever; a successful run's log
      # has served its purpose, a failed one's is kept for diagnosis.
      Remove-Item -LiteralPath $npmLog -Force -ErrorAction SilentlyContinue
    }
    if ($npmProc.ExitCode -ne 0) {
      $why = "npm install failed (exit " + $npmProc.ExitCode + "). Fix the npm error above and re-run; "
      throw ($why + "the server cannot start without its dependencies.")
    }
  } finally { Pop-Location }
  # npm's exit code is not evidence that the package works: a stub npm that exits
  # 0 without installing anything passed this step before. Re-run the same probe
  # and fail on its verdict.
  Push-Location $Root
  try {
    & $NodeExe 'deploy\check-deps.mjs' $Root 2>$null
    if ($LASTEXITCODE -ne 0) {
      $why = "npm reported success, but the dependencies still do not load from this package "
      $why += "(probe exit $LASTEXITCODE). See the probe line above."
      throw $why
    }
  } finally { Pop-Location }
  Ok "npm install completed and the dependencies load"
} else {
  Ok "dependencies verified (SDK imports), npm skipped"
}

# ---- 3. optional surface DLL (opt-in; see the header for why) ---------------
if ($WithSurface) {
Step 3 "surface DLL (opt-in via -WithSurface)"
$dll = Join-Path $Root 'native\surface\build\cw_surface.dll'
$src = Join-Path $Root 'native\surface\cw_surface.c'
$dllExists = Test-Path $dll
# Audit finding F8: the build branch used to require BOTH needBuild AND no DLL,
# so a stale DLL next to newer source took the elseif and printed "newer than
# source" — the exact opposite of the truth. Rebuild whenever needBuild says so.
$needBuild = (-not $dllExists) -or ((Get-Item $src).LastWriteTime -gt (Get-Item $dll).LastWriteTime)
if ($needBuild) {
  # The prebuilt DLL ships in the package, so this only runs when someone
  # deleted it or is deploying straight from a source checkout.
  #
  # The build is a cmd /c one-liner, NOT a PowerShell invocation. Two earlier
  # attempts failed for instructive reasons:
  #   * backtick line continuation inside this block was silently eaten
  #   * gcc's stderr warnings were promoted to NativeCommandError by PowerShell
  #     5.1 under ErrorActionPreference=Stop, aborting on -Wdiscarded-qualifiers
  # cmd /c has neither problem, and gcc's warnings land in the transcript where
  # they belong.
  $gcc = Get-Command gcc -ErrorAction SilentlyContinue
  $gccPath = "C:\Users\$env:USERNAME\scoop\apps\gcc\current\bin\gcc.exe"
  if (-not $gcc -and (Test-Path $gccPath)) { $gcc = $gccPath }
  if ($gcc) {
    Push-Location (Join-Path $Root 'native\surface')
    try {
      cmd /c "`"$gcc`" -shared -O2 -o build\cw_surface.dll cw_surface.c -lole32 -loleaut32 -lws2_32 -luuid -Wl,--kill-at 2>nul"
      if ($LASTEXITCODE -ne 0) { throw "gcc build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    Ok "built cw_surface.dll from source"
  } else {
    throw "no cw_surface.dll in the package and no gcc to build one. Restore native\surface\build\cw_surface.dll or install mingw gcc."
  }
} else {
  Ok "cw_surface.dll up to date"
}

if (-not (Test-Path $dll)) { throw "cw_surface.dll missing at $dll" }

# ---- 3.1. registration (opt-in path)
Step 3.1 "COM registration (user scope, no elevation)"
# regsvr32 calls the DLL's own DllRegisterServer, which writes
# HKCU\SOFTWARE\Classes — user-scoped by construction, so this needs no admin
# and cannot touch anything machine-wide. /s keeps the success dialog down.
$reg = Start-Process regsvr32.exe -ArgumentList @('/s', "`"$dll`"") -Wait -PassThru
if ($reg.ExitCode -ne 0) { throw "regsvr32 exited $($reg.ExitCode)" }
$clsid = '{7C4A9B21-3D5E-4F8A-9E21-6B4D380A7C51}'
$key = "HKCU:\SOFTWARE\Classes\CLSID\$clsid\InProcServer32"
if (Test-Path $key) { Ok ("registered: {0}" -f (Get-ItemProperty $key).'(default)') }
else { throw "registration did not land — $key missing after regsvr32" }

# ---- 3.2. ALSO copy into SONAR's scanned folder
# Two independent discovery paths exist and a deployment should satisfy BOTH:
#
#   1. COM registration (just done) — HKCR\CLSID\{...}\InProcServer32, which the
#      surface manager reads to CoCreateInstance the plugin.
#   2. A loose DLL in the folder named by
#      HKLM\SOFTWARE\Cakewalk Music Software\Shared Surfaces\InstallDirectory
#      (D:\CAKEWALK\Shared Surfaces here) — where the five shipped surfaces sit
#      as plain files.
#
# Measured on a live host: registration alone IS enough (hiding the folder copy
# still left "Cakewalk MCP Surface Bridge" in the picker). But a fresh-machine
# report found the opposite — the picker showed only the five shipped surfaces —
# so which path a given install relies on is not something to bet on. Doing both
# costs one file and removes the failure mode entirely.
Step 3.2 "copy into SONAR's Shared Surfaces folder (second discovery path)"
$sharedKey = 'HKLM:\SOFTWARE\Cakewalk Music Software\Shared Surfaces'
$sharedDir = $null
if (Test-Path $sharedKey) {
  $sharedDir = (Get-ItemProperty $sharedKey -Name 'InstallDirectory' -ErrorAction SilentlyContinue).InstallDirectory
}
if ($sharedDir -and (Test-Path $sharedDir)) {
  $sharedTarget = Join-Path $sharedDir 'cw_surface.dll'
  # Skip when the registration already points AT this file, so we do not copy a
  # file onto itself.
  $registeredAt = (Get-ItemProperty $key).'(default)'
  if ($registeredAt -and ($registeredAt.Trim('"') -ieq $sharedTarget)) {
    Ok "already running from Shared Surfaces: $sharedTarget"
  } else {
    Copy-Item -LiteralPath $dll -Destination $sharedTarget -Force
    Ok "copied to $sharedTarget"
  }
} else {
  Warn "Shared Surfaces folder not found in the registry - relying on COM registration only."
  Warn "If the surface does not appear in 参数设置 > MIDI > 控制界面, run:"
  Warn ("  powershell -File `"{0}`" -CopyToShared" -f (Join-Path $Root 'native\surface\install.ps1'))
}
} else {
  Step 3 "control surface DLL — SKIPPED (not installed by default)"
  Ok "nothing to do: every capability works without it (see this script's header)"
  Ok "add it only for diagnostics/experiments:  install.ps1 -WithSurface"
  Ok "note it still needs a manual re-add EVERY session; SONAR does not restore it"
}
# ---- 4. virtual MIDI cable (loopMIDI), report only ---------------------------------------
# T4 (realtime MIDI) needs a virtual MIDI cable. This machine family uses
# loopMIDI (Tobias Erichsen's free driver); the code also accepts any port whose
# name contains loopMIDI / Cakewalk. The port ENABLE side, though, is pure
# config: SONAR reads enabled MIDI devices from %APPDATA%\Cakewalk\Sonar\
# TTSSEQ.INI, and the adapter already knows how to write that file (with
# backup). Doing it here removes one manual Preferences visit.
Step 4 "virtual MIDI cable (loopMIDI)"
$ttsseq = Join-Path $env:APPDATA 'Cakewalk\Sonar\TTSSEQ.INI'
# The adapter accepts any output port whose name contains one of these
# (lib/live.js PREFERRED_PORTS). Keep the two lists in step.
$WantedPortNames = @('Studio One AI Notes', 'loopMIDI', 'Cakewalk')

# Finding the exe must not depend on where it was installed. The registry is
# useless here — measured: loopMIDI's uninstall entry carries no InstallLocation
# and its DisplayIcon points at the *installer* in Package Cache, not at the app.
# So: running process, then PATH, then Start Menu shortcuts, then a bounded
# search of the usual install roots.
function Find-LoopMidiExe {
  $proc = Get-Process loopMIDI -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc -and $proc.Path) { return @{ Path = $proc.Path; Source = 'running process' } }

  $cmd = Get-Command loopMIDI.exe -ErrorAction SilentlyContinue
  if ($cmd) { return @{ Path = $cmd.Source; Source = 'PATH' } }

  # Real install location before shortcuts. A shortcut installed by an MSI can be
  # an ADVERTISED shortcut whose target is C:\Windows\Installer\{ProductCode}\...
  # — measured on this host. That copy does run (same bytes), but it is an
  # installer artifact, and reporting it as "the loopMIDI path" is confusing and
  # would break if the cache is cleaned.
  #
  # Depth 3 is enough for the vendor's own layout (Vendor\Product\app.exe) and
  # keeps the search to a couple of seconds even on a full Program Files.
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    $hit = Get-ChildItem -LiteralPath $root -Filter 'loopMIDI.exe' -Recurse -File -Depth 3 -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { return @{ Path = $hit.FullName; Source = "searched $root" } }
  }

  # Last resort: a shortcut anywhere in either Start Menu — this is what still
  # finds a copy installed outside the three roots above.
  $shell = $null
  foreach ($root in @(
      (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
      (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $lnk = Get-ChildItem -LiteralPath $root -Filter 'loopMIDI.lnk' -Recurse -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($lnk) {
      if (-not $shell) { $shell = New-Object -ComObject WScript.Shell }
      $target = $shell.CreateShortcut($lnk.FullName).TargetPath
      if ($target -and (Test-Path -LiteralPath $target)) {
        return @{ Path = $target; Source = 'Start Menu shortcut' }
      }
    }
  }
  return $null
}

# A virtual cable's ports exist only while its app runs, so "installed" and
# "usable" are different facts. This asks the adapter itself which output ports
# it can see (deploy/list-ports.mjs), then checks for a name it would select.
function Get-VisibleMidiPorts {
  Push-Location -LiteralPath $Root
  try {
    $raw = & $NodeExe 'deploy\list-ports.mjs' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return @() }
    return @($raw | ConvertFrom-Json)
  } catch { return @() } finally { Pop-Location }
}

function Select-AdapterPort($ports) {
  foreach ($port in $ports) {
    foreach ($want in $WantedPortNames) {
      if ($port.ToLower().Contains($want.ToLower())) { return $port }
    }
  }
  return $null
}

# Install path. winget first: its manifest pins the same official artifact and
# handles elevation. The fallback downloads that artifact directly and verifies
# it against the hash recorded in that manifest, so the two paths install the
# same bytes. The package is downloaded at install time, never redistributed
# (loopMIDI is proprietary freeware).
#
# BOTH attempts are time-bounded. Measured the hard way: an unanswered UAC prompt
# leaves `winget install` waiting forever, so a deploy started in the background
# (or by someone who cannot see the prompt) hung with no output and no way
# forward. A timeout turns that into a warning and lets the rest of the install
# finish — loopMIDI is optional, so failing to get it must not block anything.
# Launch the vendor installer and wait for loopMIDI to appear. `start` rather
# than Start-Process -Verb RunAs: it hands the request to the interactive
# desktop, which is where a UAC prompt can actually be shown. A background caller
# asking for elevation directly gets ERROR_CANCELLED with no prompt ever
# appearing — measured repeatedly on this host.
function Start-LoopMidiSetup([string]$setupPath, [int]$budgetSec = 300) {
  # A non-positive budget starts NOTHING, so an expired budget cannot still buy a
  # UAC prompt. A positive budget is spent exactly as given.
  if ($budgetSec -le 0) { return $false }
  Write-Host '      running the loopMIDI installer (a UAC prompt may appear — please accept it)'
  # Deadline BEFORE the launcher: the launcher itself can block on a UAC answer.
  # Start-Process (not `& cmd /c`) returns immediately and keeps the same hidden
  # `start` hand-off to the interactive desktop.
  $deadline = (Get-Date).AddSeconds($budgetSec)
  $launcher = $null
  try {
    $launcher = Start-Process -FilePath 'cmd.exe' `
      -ArgumentList @('/c', "start `"`" `"$setupPath`" /quiet /norestart") `
      -WindowStyle Hidden -PassThru
  } catch {
    Warn ("the loopMIDI installer could not be launched: {0}" -f $_.Exception.Message)
  }
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (Find-LoopMidiExe) { return $true }
  }
  # Cleanup only OUR launcher object, and only while it is still running: a
  # numeric PID whose process already exited may have been reused by something
  # else (including a consent dialog), which must never be killed here.
  if ($launcher) {
    try { if (-not $launcher.HasExited) { $launcher.Kill() } } catch { }
  }
  Warn 'the loopMIDI install budget ran out; a UAC prompt may still be on screen — accept it or dismiss it and re-run this installer.'
  return $false
}

function Install-LoopMidiPackage([int]$budgetSec = 360) {
  # ONE budget for all three routes, enforced exactly: each route is gated BEFORE
  # it starts any work (lookup, process creation, download) and every wait uses
  # the seconds actually left, never a floor. The 360 s default is required: with
  # no declaration the budget is 0 and the default success path never runs.
  $budget = [int]$budgetSec
  if ($budget -le 0) {
    Warn 'the loopMIDI install budget is already exhausted; not starting any install route.'
    return $null
  }
  $overallDeadline = (Get-Date).AddSeconds($budget)
  $remaining = { [int][math]::Floor(($overallDeadline - (Get-Date)).TotalSeconds) }
  # 1. The installer SHIPPED IN THE PACKAGE, so a machine with no network can
  #    still get the virtual cable. Redistributed with the author's permission
  #    (see vendor/loopMIDI/NOTICE.txt); the file is the vendor's own, unmodified
  #    and signature-checked here before it runs.
  $bundledSetup = Join-Path $Root 'vendor\loopMIDI\loopMIDISetup.exe'
  if (Test-Path -LiteralPath $bundledSetup) {
    if ((& $remaining) -le 0) {
      Warn 'the loopMIDI install budget is exhausted; skipping the bundled installer.'
    } else {
      $sig = Get-AuthenticodeSignature -LiteralPath $bundledSetup
      if ($sig.Status -ne 'Valid') {
        Warn ("the bundled loopMIDI installer failed its signature check ({0}); not running it." -f $sig.Status)
      } else {
        Write-Host '      installing from the bundled package (no download needed)'
        # Seconds left AFTER the signature check, never a floor. -Out-Null: the
        # helper returns a boolean and must not leak into the pipeline.
        Start-LoopMidiSetup $bundledSetup (& $remaining) | Out-Null
        $found = Find-LoopMidiExe
        if ($found) { return $found }
        Warn 'the bundled installer did not complete; trying the other routes'
      }
    }
  }

  # 2. winget, 3. the official download. The deadline is checked BEFORE winget is
  #    looked up or a process is created: a route that never starts cannot
  #    outlive the budget.
  $wingetLeft = & $remaining
  if ($wingetLeft -le 0) {
    Warn 'the loopMIDI install budget is exhausted; skipping winget and the official download.'
  } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host '      installing via winget: TobiasErichsen.loopMIDI'
    # The Get-Command lookup above may have consumed time, so the budget is
    # checked again immediately before the process is created.
    $launchLeft = & $remaining
    $wingetExpired = $false
    if ($launchLeft -le 0) {
      $wingetExpired = $true
      Warn 'the loopMIDI install budget is exhausted; winget was not started.'
    } else {
      try {
        $wp = Start-Process -FilePath 'cmd.exe' `
          -ArgumentList @('/c', 'winget install --id TobiasErichsen.loopMIDI -e --silent --accept-package-agreements --accept-source-agreements >nul 2>&1') `
          -WindowStyle Hidden -PassThru
      } catch {
        Warn ("winget could not be launched: {0}" -f $_.Exception.Message)
      }
      if ($wp) {
        # Only the seconds actually left; a wait of 0 would mean an instant timeout.
        $waitLeft = & $remaining
        if ($waitLeft -le 0) {
          try { if (-not $wp.HasExited) { $wp.Kill() } } catch { }
          $wingetExpired = $true
          Warn 'the loopMIDI install budget is exhausted; winget was stopped.'
        } elseif (-not $wp.WaitForExit($waitLeft * 1000)) {
          try { if (-not $wp.HasExited) { $wp.Kill() } } catch { }
          Warn ("winget did not finish within the {0}s left of the loopMIDI install budget — the UAC prompt was probably not answered." -f $waitLeft)
          Warn 'If a "用户帐户控制" dialog is still on screen, accept it and re-run this installer.'
        }
      }
    }
    $found = Find-LoopMidiExe
    if ($found) {
      return $found
    } elseif ($wingetExpired) {
      return $null
    }
    Warn 'winget did not install it; trying the official package directly.'
  }

  $url = 'https://www.tobias-erichsen.de/wp-content/uploads/2020/01/loopMIDISetup_1_0_16_27.zip'
  $sha = '975399eb76e2c5a1d553ecd8975ab361261ccab8fd9412b8060b19877cb4e0d5'
  $tmp = Join-Path $env:TEMP ('loopmidi-' + [Guid]::NewGuid().ToString('n').Substring(0, 8))
  # Gate BEFORE any preparation work: an expired budget must not even create a temp dir.
  if ((& $remaining) -le 0) {
    Warn 'the loopMIDI install budget is exhausted; not downloading the official package.'
    return (Find-LoopMidiExe)
  }
  try {
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zip = Join-Path $tmp 'loopmidi.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    # The preparation above may have consumed the budget, so the seconds left are
    # refreshed here and the request is skipped (no download) when nothing remains.
    $downloadLeft = & $remaining
    if ($downloadLeft -le 0) {
      Warn 'the loopMIDI install budget is exhausted by preparation; not downloading the official package.'
      return (Find-LoopMidiExe)
    }
    # min(120, seconds left): a 10 s remainder must not hold a request open 2 minutes.
    $downloadTimeout = [math]::Min(120, $downloadLeft)
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec $downloadTimeout
    # The download itself may have outlived the budget; do not start post-work on it.
    if ((& $remaining) -le 0) {
      Warn 'the loopMIDI install budget expired during the download; not extracting or installing.'
      return (Find-LoopMidiExe)
    }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $sha) { throw "downloaded package does not match the pinned hash ($actual)" }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $setup = Get-ChildItem -LiteralPath $tmp -Filter 'loopMIDISetup*.exe' -File |
      Select-Object -First 1
    if (-not $setup) { throw 'loopMIDISetup.exe is missing from the package' }
    if ((Get-AuthenticodeSignature -LiteralPath $setup.FullName).Status -ne 'Valid') {
      throw 'the loopMIDI installer signature is not valid'
    }
    # `start` rather than Start-Process -Verb RunAs: it hands the request to the
    # interactive desktop, which is where a UAC prompt can actually be shown.
    # A background caller asking for elevation directly gets ERROR_CANCELLED with
    # no prompt ever appearing — measured repeatedly on this host.
    # The helper starts NOTHING on a non-positive budget, so an expired overall
    # deadline cannot buy a final UAC prompt.
    Start-LoopMidiSetup $setup.FullName (& $remaining) | Out-Null
    $found = Find-LoopMidiExe
    if ($found) { return $found }
    Warn 'the official installer did not finish within the loopMIDI install budget — UAC was probably not answered.'
    return $null
  } catch {
    Warn ("loopMIDI could not be installed automatically: {0}" -f $_.Exception.Message)
    return $null
  } finally {
    # Do not delete the extraction directory while an accepted UAC prompt may
    # still be starting the installer from it.
    if (-not (Get-Process -Name 'loopMIDISetup*' -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  return [object](Find-LoopMidiExe)
}

# loopMIDI builds its ports from HKCU\Software\Tobias Erichsen\loopMIDI\Ports
# (value name = port name, value = 1) and reads that key AT STARTUP. A freshly
# installed loopMIDI therefore has zero ports, which is exactly the state the
# adapter cannot use. Writing the value and restarting the app does what a user
# does by typing a name and pressing "+", without the visit.
function Test-LoopMidiExecutable([string]$exePath) {
  try {
    $signature = Get-AuthenticodeSignature -LiteralPath $exePath -ErrorAction Stop
    return $signature.Status -eq 'Valid' -and
      $signature.SignerCertificate.Subject -match '(?i)(^|,\s*)CN=Tobias Erichsen(,|$)'
  } catch { return $false }
}

function Ensure-LoopMidiPort([string]$exePath) {
  $key = 'HKCU:\Software\Tobias Erichsen\loopMIDI\Ports'
  $name = 'loopMIDI Port'
  try {
    if (-not (Test-LoopMidiExecutable $exePath)) {
      Warn 'loopMIDI executable publisher could not be verified; no process was started or stopped.'
      return $false
    }
    $running = @(Get-Process loopMIDI -ErrorAction SilentlyContinue)
    $foreign = @($running | Where-Object {
      -not $script:ownedLoopMidi -or $_.Id -ne $script:ownedLoopMidi.Id -or
        $_.StartTime -ne $script:ownedLoopMidi.StartTime
    })
    if ($foreign.Count -gt 0) {
      Warn 'An existing loopMIDI instance was left untouched. Add a port in loopMIDI, or restart it yourself when other applications are idle.'
      return $false
    }
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    $existing = (Get-Item -LiteralPath $key).Property
    if ($existing -contains $name) { return $false }
    New-ItemProperty -LiteralPath $key -Name $name -Value 1 -PropertyType DWord -Force | Out-Null
    if ($script:ownedLoopMidi -and -not $script:ownedLoopMidi.HasExited) {
      Stop-Process -InputObject $script:ownedLoopMidi -Force -ErrorAction Stop
      Start-Sleep -Seconds 1
    }
    $script:ownedLoopMidi = Start-Process -FilePath $exePath -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 5
    return $true
  } catch {
    Warn ('MIDI port setup did not complete: ' + $_.Exception.Message)
    return $false
  }
}

$loopMidiInfo = Find-LoopMidiExe
if (-not $loopMidiInfo -and $LoopMidi -ne 'skip') {
  Write-Host '      loopMIDI is not installed; attempting the official package'
  $loopMidiInfo = Install-LoopMidiPackage
}

if ($loopMidiInfo) {
  Ok ("loopMIDI found: {0} ({1})" -f $loopMidiInfo.Path, $loopMidiInfo.Source)
  # -LoopMidi skip means "report only, never touch the machine". Starting the app
  # was outside that guard, so a skip run still launched it.
  if ($LoopMidi -eq 'skip') {
    if (Get-Process loopMIDI -ErrorAction SilentlyContinue) { Ok 'loopMIDI is running (left alone: -LoopMidi skip)' }
    else { Warn 'loopMIDI is installed but not running; -LoopMidi skip means it will not be started' }
  } elseif (-not (Get-Process loopMIDI -ErrorAction SilentlyContinue)) {
    if (Test-LoopMidiExecutable $loopMidiInfo.Path) {
      $script:ownedLoopMidi = Start-Process -FilePath $loopMidiInfo.Path -PassThru -WindowStyle Hidden
      Start-Sleep -Seconds 4
      Ok 'loopMIDI started'
    } else { Warn 'loopMIDI publisher could not be verified; installed executable was left untouched.' }
  } else { Ok 'loopMIDI is running' }

  $ports = Get-VisibleMidiPorts
  $match = Select-AdapterPort $ports
  if (-not $match -and $LoopMidi -ne 'skip' -and $loopMidiInfo -and $loopMidiInfo.Path) {
    # No usable port: a fresh loopMIDI has none. Create the default one and
    # restart the app so it rebuilds from the registry.
    $created = Ensure-LoopMidiPort $loopMidiInfo.Path
    if ($created) {
      Ok 'loopMIDI had no ports, so one was added and loopMIDI restarted'
      $ports = Get-VisibleMidiPorts
      $match = Select-AdapterPort $ports
    }
  }
  if ($match) {
    Ok ("MIDI port the adapter can use: {0}" -f $match)
    # Enable it in SONAR's own input list, so the "参数设置 > MIDI > 设备" visit is
    # not needed either. Only when SONAR is NOT running: a running instance holds
    # its MIDI list in memory and rewrites TTSSEQ.INI when that dialog is applied,
    # which would silently undo this entry.
    #
    # -LoopMidi skip means "report only, never touch the machine", so it also
    # suppresses this write — otherwise the switch would still edit TTSSEQ.INI.
    if ($LoopMidi -eq 'skip') {
      $script:midiStatus = 'skipped'
      Write-Host '      (port not enabled: -LoopMidi skip means report only)'
    } elseif (Get-Process Sonar -ErrorAction SilentlyContinue) {
      $script:midiStatus = 'sonar-running'
      Warn ("SONAR is running, so its MIDI input list was left untouched — enable '{0}' in 参数设置 > MIDI > 设备." -f $match)
    } else {
      Push-Location -LiteralPath $Root
      try {
        $midiRaw = & $NodeExe 'deploy\enable-midi-input.mjs' $match 2>$null
        $midiResult = $null
        if ($LASTEXITCODE -eq 0 -and $midiRaw) { $midiResult = $midiRaw | ConvertFrom-Json }
      } finally { Pop-Location }
      if ($midiResult -and $midiResult.ok) {
        if ($midiResult.changed) {
          $note = if ($midiResult.createdFile) { ' (TTSSEQ.INI created)' } else { '' }
          Ok ("enabled '{0}' as a SONAR MIDI input{1}" -f $match, $note)
        } else {
          Ok ("SONAR already had '{0}' enabled" -f $match)
        }
        $script:midiEnabledByInstaller = $true
        $script:midiStatus = 'enabled'
        Write-Host '      SONAR reads this at its next start.'
      } else {
        $why = if ($midiResult) { $midiResult.error } else { 'the helper produced no output' }
        $script:midiStatus = 'failed'
        Warn ("could not enable it automatically: {0}" -f $why)
        Write-Host ("      Enable it in SONAR: 参数设置 > MIDI > 设备, tick '{0}'." -f $match)
      }
    }
  } else {
    $script:midiStatus = 'no-port'
    Warn 'loopMIDI is running but has no port this adapter recognises.'
    Write-Host "      Open loopMIDI and add a port (any name containing 'loopMIDI' works),"
    Write-Host '      then re-run this installer or just start using the adapter.'
    if ($ports.Count) { Write-Host ("      Ports visible now: {0}" -f ($ports -join ', ')) }
  }
} else {
  $script:midiStatus = 'no-loopmidi'
  Warn 'loopMIDI is NOT available - realtime MIDI (notes, volume, pan) will be unavailable.'
  Write-Host '      Everything else works without it.'
  Write-Host '      Install it free from https://www.tobias-erichsen.de/software/loopmidi.html'
  Write-Host '      then re-run this installer. To skip this check: -LoopMidi skip'
}

# ---- 4b. is SONAR signed in? ------------------------------------------------
# Not a capability check — a precondition for the click-based track tools.
# Measured on a clean install: an unactivated SONAR exposes 52 accessibility
# elements and none of the "<label> on Track N" controls; after signing in the
# same window exposes 402. The installer cannot sign in for the user, but it can
# say so before every track write fails for a non-obvious reason.
Push-Location -LiteralPath $Root
try {
  $stateRaw = & $NodeExe 'deploy\sonar-state.mjs' 2>$null
  $sonarState = $null
  if ($LASTEXITCODE -eq 0 -and $stateRaw) { $sonarState = $stateRaw | ConvertFrom-Json }
} finally { Pop-Location }
if ($sonarState -and $sonarState.known -and $sonarState.signedIn -eq $false) {
  $script:sonarNotSignedIn = $true
  Warn 'SONAR is NOT signed in.'
  Write-Host '      Until you sign in once, SONAR does not expose the track-strip controls, so'
  Write-Host '      cw_set_track_mute / solo / arm and cw_set_track_name will fail.'
} elseif ($sonarState -and $sonarState.known) {
  # The title proves only that no activation marker is present. A Free License
  # session is "signed in" and STILL hides the track-strip controls, so a green
  # "signed in" line is the first thing a user sees and the first thing that is
  # wrong. Report the limit as a limit.
  $script:sonarLicenceUnknown = $true
  Write-Host '      SONAR is running and no activation marker is on the title.'
  Write-Host '      The LICENCE TIER could not be read from here. On a Free Licence, SONAR'
  Write-Host '      shows the track strips but no per-control children, so these will fail:'
  Write-Host '        cw_set_track_mute / solo / arm, cw_set_track_name, cw_get_track_control'
  Write-Host '      Writing music is unaffected (file import/export works on any licence).'
} else {
  Write-Host '      SONAR is not running, so its sign-in state could not be checked.'
  Write-Host '      Sign in once before using the track tools (see QUICKSTART).'
}
# The MaxInPort lesson stays on the record, because it is why this code does not
# hand-write the device list:
#
# An earlier version wrote MaxInPort=-1 with the comment "all devices", which was
# a guess and is WRONG. TTSSEQ.INI lists devices as dense 0-based entries under a
# Max key that holds the HIGHEST INDEX, not a mode flag. MaxInPort=1 means
# "indices 0 and 1 are enabled"; -1 disables everything, so on a machine with two
# enabled ports that write would have silently turned MIDI input off.
#
# Enabling therefore goes through deploy/enable-midi-input.mjs -> enablePort() in
# lib/midi-config.js, the code that was fixed and tested against a pristine file,
# an already-configured file and a file carrying a duplicate Max key. The check
# below only reports what ended up on disk.
if (Test-Path $ttsseq) {
  $maxIn = (Select-String -Path $ttsseq -Pattern '^MaxInPort=(-?\d+)' -ErrorAction SilentlyContinue)
  if ($maxIn -and [int]$maxIn.Matches[0].Groups[1].Value -ge 0) {
    # Authoritative: whatever the path, the file now carries at least one enabled
    # input, so NEXT STEPS should not send the user to Preferences.
    $script:midiEnabledByInstaller = $true
    Ok "TTSSEQ.INI has MIDI inputs configured"
  } else {
    Warn "No SONAR MIDI inputs are enabled."
    Write-Host "      If SONAR was running, the list was left alone on purpose. Enable the"
    Write-Host "      device in 参数设置 > MIDI > 设备, or close SONAR and re-run this installer."
  }
} else {
  if ($LoopMidi -eq 'skip') {
    # Under skip nothing was enabled on purpose; saying "no usable port was found"
    # sent the user chasing a problem that does not exist.
    Write-Host '      MIDI input was not enabled: -LoopMidi skip means report only.'
  } else {
    Warn "TTSSEQ.INI still does not exist."
    Write-Host "      No usable port was found to enable. Start SONAR once so it writes its"
    Write-Host "      MIDI configuration, then re-run this installer."
  }
}



# ---- 5. doctor ------------------------------------------------------------
# Always step 5: steps 3.1/3.2 exist only under -WithSurface, and the
# MIDI check is step 4 on both paths.
# The number is chosen rather than hard-coded: without -WithSurface this is the
# fourth thing the run does, and with it the surface steps occupy 3 through 4b.
# Printing "5" in both cases is what produced a log that jumped 3 -> 5 and read
# like a skipped step.
if (-not $SkipDoctor) {
  $doctorStep = '5'
  Step $doctorStep "health check (cw_doctor)"
  Push-Location $Root
  try {
    # process.exit(0) is NOT cosmetic. doctor's host probe opens the long-lived
    # user32 shim child, and its stdio pipes keep node's event loop alive after
    # the verdict prints. Under a redirected stdout (this install logs to a
    # file) the buffered output is then never flushed and PowerShell waits on
    # node forever — the whole install appeared to hang in step 5 with the
    # doctor's own results already computed. An explicit exit flushes and ends.
    $out = & $NodeExe -e "import('./lib/doctor.js').then(m => m.doctor()).then(r => { console.log('verdict: ' + r.verdict); for (const c of r.channels) console.log('  ' + c.probe.padEnd(18) + c.verdict); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); })"
    $out | ForEach-Object { Write-Host "      $_" }
    # 'installed' and 'healthy' are different claims. The doctor failing (or the
    # node call itself erroring) must be visible as a WARNING on the install
    # result, not silently absorbed — the old block printed the output and moved
    # on either way.
    if ($LASTEXITCODE -ne 0) {
      Warn 'doctor could not run - install is complete but UNVERIFIED. Check it with the cw_doctor tool or the deploy README.'
    } elseif (($out -join ' ') -match 'unhealthy') {
      # On a machine where SONAR has never been started — the normal state right
      # after a clean install — every channel is unavailable because there is no
      # host to talk to, and overall() has no 'pass' to anchor on, so it answers
      # "unhealthy". Reporting that as "a channel is down" sends people hunting
      # for a fault when the only missing thing is a launch.
      if (($out -join ' ') -match 'host\s+unavailable') {
        Warn 'SONAR is not running, so most channels could not be checked.'
        Write-Host '      That is expected before the first launch. Start SONAR, then re-run'
        Write-Host '      cw_doctor (or this installer) for a real verdict.'
      } else {
        Warn "doctor says unhealthy — installed, but a channel is down. See the listing above."
      }
    } else {
      Ok "doctor verdict: healthy or partially-healthy (expected on a fresh install)"
    }
  } finally { Pop-Location }
}

Write-Host ""
if ($script:sonarRuntimeOk -eq $false) {
  # Deliberately not a green "installed.". The package is in place, but the
  # application it drives cannot launch — calling that a success is the exact
  # failure this check exists to prevent.
  Write-Host "installed, but SONAR cannot start yet." -ForegroundColor Yellow
  Write-Host "  Install the Visual C++ 2015-2022 Redistributable (x64), then re-run this installer:"
  Write-Host "  https://aka.ms/vs/17/release/vc_redist.x64.exe"
} else {
  Write-Host "installed." -ForegroundColor Green
}
Write-Host ""
if ($WithSurface) {
  Write-Host "NEXT STEPS (you opted into the surface, so one manual step returned):"
  Write-Host ("  1. point your MCP client at:  {0}" -f (Join-Path $Root "runtime\node.exe bin\cakewalk-mcp.js"))
  Write-Host "  2. in SONAR: 参数设置 > MIDI > 控制界面 > the arrow button > pick"
  Write-Host "     'Cakewalk MCP Surface Bridge' > 确定. SONAR does NOT restore this"
  Write-Host "     at startup (no LoadSurfaces exists in it) — repeat it EVERY session."
  Write-Host "  3. open a project — several tools need one"
} else {
  Write-Host "NEXT STEPS (there is no per-session step any more):"
  Write-Host ("  1. point your MCP client at:  {0}" -f (Join-Path $Root "runtime\node.exe bin\cakewalk-mcp.js"))
  Write-Host "  2. open a project in SONAR — several tools need one (the doctor says"
  Write-Host "     which, and cw_document_state answers 'is one open' directly)"
  switch ($script:midiStatus) {
    'enabled' {
      Write-Host "  3. MIDI input: already enabled — nothing to do"
    }
    'sonar-running' {
      Write-Host "  3. MIDI input: enable loopMIDI's port in SONAR"
      Write-Host "     参数设置 > MIDI > 设备 (skipped because SONAR was running),"
      Write-Host "     or close SONAR and re-run this installer"
    }
    'skipped' {
      Write-Host "  3. MIDI input: not enabled (-LoopMidi skip was used)"
    }
    'no-port' {
      Write-Host "  3. MIDI input: loopMIDI has no usable port"
      Write-Host "     Open loopMIDI and press + to add one, then re-run this installer"
    }
    'failed' {
      Write-Host "  3. MIDI input: the automatic enable failed; see the message above"
    }
    default {
      Write-Host "  3. MIDI input: enable loopMIDI's port in SONAR"
      Write-Host "     参数设置 > MIDI > 设备, or the adapter's cw_enable_midi_port"
    }
  }
  if ($script:sonarNotSignedIn) {
    Write-Host "  4. SIGN IN TO SONAR — until you do, the track-strip tools"
    Write-Host "     (mute / solo / arm / rename) will fail"
  } elseif ($script:sonarLicenceUnknown) {
    Write-Host "  4. TRACK-STRIP TOOLS NEED A PAID SONAR LICENCE. They work only when"
    Write-Host "     SONAR exposes the per-control children; a Free Licence does not."
    Write-Host "     Everything else (writing music, import/export) works regardless."
  }
}
Write-Host ""
Write-Host "restart the MCP client after installing: a running server keeps its old"
Write-Host "module graph, so a newly installed or updated tool can report as missing."
Write-Host ""
Write-Host "uninstall:  powershell -ExecutionPolicy Bypass -File deploy\uninstall.ps1"

# Exit non-zero when the thing this adapter DRIVES cannot start. double-click.ps1
# turns a non-zero installer exit into "部署失败"; leaving it at 0 printed a green
# success line on top of a warning that SONAR would crash at launch.
if ($script:sonarRuntimeOk -eq $false) { exit 2 }
exit 0

} finally {
  Exit-InstallerLock $installerLock
}
