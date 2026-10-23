// bridge/agent.js — long-lived PowerShell bridge into SONAR.
//
// IMPORTANT: every user32 P/Invoke that takes a string MUST be declared with
// CharSet.Unicode. PowerShell 5.1's Add-Type defaults to ANSI marshalling, so
// without it FindWindowW("Sonar", "Cakewalk Sonar") silently returns 0.
//
// Operations (line-delimited JSON on stdin, one JSON reply per request):
//   status      – locate SONAR, enumerate XCD*/LLM* windows, report version
//   probe       – send an arbitrary registered window message with a JSON body
//   msgids      – resolve registered window message names to numeric ids
//   menu        – dump the real Win32 menu tree (labels + GetMenuItemID values)
//   runmenu     – trigger a menu command by numeric id via WM_COMMAND
//   overlays    – list/close modal overlay windows that swallow WM_COMMAND
//   quit        – stop the bridge
//
// Why runmenu exists: SONAR's customer area is JUCE/Direct2D drawing, but the
// menu bar is a real Win32 menu. PostMessage(hwnd, WM_COMMAND, id, 0) executes
// the command. That works across SONAR versions because the ids come from the
// live menu, not from a hardcoded table. It only fails for commands the build
// registers without a handler (see README: CakeScript execution in 2026.10).

import { spawn } from 'node:child_process';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Force UTF-8 on stdout. PowerShell 5.1 otherwise writes in the console's ANSI
# code page (GBK on a Chinese Windows), while this bridge reads the pipe as
# UTF-8 — so every non-ASCII window caption came back mangled. Measured on a
# clean reinstall: the SONAR caption "baseline.mid - Cakewalk Sonar [未激活]"
# arrived as "baseline.mid - Cakewalk Sonar [δ����]", which failed every title
# match and made an open project look like no project at all.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class CwBridge {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint RegisterWindowMessageW(string s);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int GetClassName(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")]
  public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")]
  public static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")]
  public static extern int GetMenuItemCount(IntPtr hMenu);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetMenuStringW(IntPtr hMenu, uint uItem, StringBuilder lp, int n, uint flags);
  [DllImport("user32.dll")]
  public static extern IntPtr GetSubMenu(IntPtr hMenu, int n);
  [DllImport("user32.dll")]
  public static extern uint GetMenuItemID(IntPtr hMenu, int n);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [StructLayout(LayoutKind.Sequential)]
  public struct COPYDATASTRUCT { public IntPtr dwData; public uint cbData; public IntPtr lpData; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
}
'@

$script:MF_BYPOSITION = 0x400

# Enumerate every top-level window belonging to a given process id.
function Get-WindowsByPid {
  param([uint32] $TargetPid)
  $res = New-Object System.Collections.Generic.List[object]
  $cb = [CwBridge+EnumProc]{
    param($h, $p)
    $t = 0
    [CwBridge]::GetWindowThreadProcessId($h, [ref]$t) | Out-Null
    if ($t -eq $script:enumPid) {
      $c = New-Object Text.StringBuilder 256
      [CwBridge]::GetClassName($h, $c, 256) | Out-Null
      $tt = New-Object Text.StringBuilder 256
      [CwBridge]::GetWindowText($h, $tt, 256) | Out-Null
      $res.Add([pscustomobject]@{
        hwnd    = $h.ToInt64()
        hwndHex = $h.ToInt64().ToString('X8')
        cls     = $c.ToString()
        title   = $tt.ToString()
        visible = [CwBridge]::IsWindowVisible($h)
      }) | Out-Null
    }
    return $true
  }
  $script:enumPid = $TargetPid
  [CwBridge]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $res
}

# Read the document tab's caption, which is where this SONAR build marks an
# unsaved project ("release-host.mid*"). The main frame caption does NOT carry
# the asterisk for an imported MIDI document, so reading only the frame title
# reported modified:false and safeToClose:true for a dirty project — a data-loss
# trap for any caller that trusted it. Child windows are cheap to enumerate and
# the tab is a real Win32 child (class "C"), not a UIA-only element.
#
# Returns the matching tab title, preferring the "*" form when both a plain and
# a dirty child exist, or $null when the frame title has no document name or no
# child matches.
function Get-DocumentTab {
  param([IntPtr] $Frame, [string] $FrameTitle)
  $doc = $null
  $m = [regex]::Match($FrameTitle, '^(.*?)\s*-\s*Cakewalk Sonar\b')
  if ($m.Success) { $doc = $m.Groups[1].Value.Trim() }
  if (-not $doc) {
    $m2 = [regex]::Match($FrameTitle, '^.*?\s*-\s*\[(.+?)(\*)?\]\s*$')
    if ($m2.Success) { $doc = $m2.Groups[1].Value.Trim() }
  }
  if (-not $doc) { return $null }
  $base = $doc -replace '\*$', ''
  $hits = New-Object System.Collections.Generic.List[string]
  $cb = [CwBridge+EnumProc]{
    param($h, $p)
    $sb = New-Object Text.StringBuilder 512
    [CwBridge]::GetWindowText($h, $sb, 512) | Out-Null
    $t = $sb.ToString()
    if ($t -eq $base -or $t -eq ($base + '*')) { $hits.Add($t) | Out-Null }
    return $true
  }
  [CwBridge]::EnumChildWindows($Frame, $cb, [IntPtr]::Zero) | Out-Null
  if ($hits.Count -eq 0) { return $null }
  $dirty = $hits | Where-Object { $_ -eq ($base + '*') } | Select-Object -First 1
  if ($dirty) { return $dirty }
  return ($hits | Select-Object -First 1)
}

# Names of windows that are modal overlays: while one is open SONAR drops
# WM_COMMAND to the main window, so menu automation must close them first.
function Get-Overlays {
  param([uint32] $TargetPid)
  $res = New-Object System.Collections.Generic.List[object]
  $cb = [CwBridge+EnumProc]{
    param($h, $p)
    $t = 0
    [CwBridge]::GetWindowThreadProcessId($h, [ref]$t) | Out-Null
    if ($t -eq $script:ovPid -and [CwBridge]::IsWindowVisible($h)) {
      $c = New-Object Text.StringBuilder 256
      [CwBridge]::GetClassName($h, $c, 256) | Out-Null
      $cls = $c.ToString()
      $parent = [CwBridge]::GetParent($h)
      # JUCE panels and modal dialogs over the main window are the blockers.
      if ($cls -match 'JUCE' -or ($cls -eq '#32770' -and $parent -ne [IntPtr]::Zero)) {
        $tt = New-Object Text.StringBuilder 256
        [CwBridge]::GetWindowText($h, $tt, 256) | Out-Null
        $res.Add([pscustomobject]@{
          hwndHex = $h.ToInt64().ToString('X8')
          cls     = $cls
          title   = $tt.ToString()
          parent  = $parent.ToInt64().ToString('X8')
        }) | Out-Null
      }
    }
    return $true
  }
  $script:ovPid = $TargetPid
  [CwBridge]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $res
}

# Locate the SONAR main frame.
#
# The frame's class is always "Sonar"; its title is "Cakewalk Sonar" when no
# project is open and "Cakewalk Sonar - [name.cwp]" once one is. Matching the
# title exactly therefore works right up until a project loads, and the old
# fallback — "the process's first visible window with a title" — then picked the
# wrong window, because SONAR also owns titled helper windows (HUDNow,
# HUDNowTime) in the same process. Prefer the class, with a title prefix as a
# tie-breaker.
function Find-SonarMain {
  foreach ($title in @('Cakewalk Sonar', $null)) {
    $h = [CwBridge]::FindWindowW('Sonar', $title)
    if ($h -ne [IntPtr]::Zero) { return $h }
  }
  $procs = @(Get-Process -Name 'Sonar' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return [IntPtr]::Zero }
  $wins = Get-WindowsByPid $procs[0].Id
  # Prefer a window whose class is exactly "Sonar"…
  foreach ($w in $wins) { if ($w.cls -eq 'Sonar' -and $w.visible) { return [IntPtr]$w.hwnd } }
  # …then one whose title starts with the product name…
  foreach ($w in $wins) { if ($w.visible -and $w.title -like 'Cakewalk Sonar*') { return [IntPtr]$w.hwnd } }
  # …and only then anything visible, so a renamed build still resolves.
  #
  # HUD windows are excluded from BOTH fallbacks. HUDNow / HUDNowTime are SONAR's
  # floating transport readouts; they are always present, always titled, and
  # never the frame. The last-resort branch once returned HUDNow when the real
  # frame was gone, and everything reading the title then reported the HUD's
  # caption as the document state — 'HUDNow' as a project name, 'no project
  # open' while one was open. Returning Zero when only HUDs remain is the honest
  # answer: the frame is genuinely not there.
  $isHud = { param($w) $w.title -match '^HUDNow' -or $w.cls -match '^Afx:.*:0$' }
  foreach ($w in $wins) {
    if ($w.visible -and $w.title -ne '' -and (-not (& $isHud $w))) { return [IntPtr]$w.hwnd }
  }
  return [IntPtr]::Zero
}

function Send-Json {
  param([IntPtr] $hwnd, [uint32] $msgId, [string] $json)
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $hMem = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length + 1)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $hMem, $bytes.Length)
  $cds = New-Object CwBridge+COPYDATASTRUCT
  $cds.dwData = [IntPtr]0xC0DE
  $cds.cbData = [uint32]$bytes.Length
  $cds.lpData = $hMem
  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal([Runtime.InteropServices.Marshal]::SizeOf($cds))
  [Runtime.InteropServices.Marshal]::StructureToPtr($cds, $ptr, $false)
  $r = [IntPtr]::Zero
  [CwBridge]::SendMessageTimeoutW($hwnd, $msgId, [IntPtr]0xC0DE, $ptr, 2, 4000, [ref]$r) | Out-Null
  [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) | Out-Null
  [Runtime.InteropServices.Marshal]::FreeHGlobal($hMem) | Out-Null
  return $r.ToInt64()
}

# Walk the real Win32 menu bar of the main window. This is version-independent:
# whatever the build exposes is what we can drive.
function Get-MenuTree {
  param([IntPtr] $hMain, [IntPtr] $hMenu, [int] $depth)
  $items = New-Object System.Collections.Generic.List[object]
  if ($hMenu -eq [IntPtr]::Zero) { return $items }
  $n = [CwBridge]::GetMenuItemCount($hMenu)
  for ($i = 0; $i -lt $n; $i++) {
    $sb = New-Object Text.StringBuilder 512
    [void][CwBridge]::GetMenuStringW($hMenu, [uint32]$i, $sb, 512, $script:MF_BYPOSITION)
    $label = $sb.ToString()
    $id = [CwBridge]::GetMenuItemID($hMenu, $i)
    $sub = [CwBridge]::GetSubMenu($hMenu, $i)
    $entry = [ordered]@{
      index   = $i
      label   = $label
      cmdId   = if ($id -eq 0xFFFFFFFF) { $null } else { [int64]$id }
      cmdHex  = if ($id -eq 0xFFFFFFFF) { $null } else { '0x' + $id.ToString('X4') }
      hasMenu = ($sub -ne [IntPtr]::Zero)
    }
    if ($depth -lt 2 -and $sub -ne [IntPtr]::Zero) {
      $entry.children = Get-MenuTree $hMain $sub ($depth + 1)
    }
    $items.Add([pscustomobject]$entry) | Out-Null
  }
  return $items
}

function Get-Status {
  $hMain = Find-SonarMain
  $info = [ordered]@{ sonar = [ordered]@{}; assistant = [ordered]@{}; overlays = @(); windows = @() }
  if ($hMain -eq [IntPtr]::Zero) {
    $info.sonar = [ordered]@{ found = $false; hint = 'Cakewalk SONAR does not appear to be running. Start it and open a project.' }
    return (ConvertTo-Json -Depth 8 -Compress $info)
  }
  $tid = 0
  [CwBridge]::GetWindowThreadProcessId($hMain, [ref]$tid) | Out-Null
  $wins = Get-WindowsByPid $tid
  $interesting = @()
  foreach ($w in $wins) {
    if ($w.cls -match 'XCD|LLM|Agent|Cake|JUCE|Script') { $interesting += $w }
  }
  $frame = $wins | Where-Object { $_.hwnd -eq $hMain.ToInt64() } | Select-Object -First 1
  $frameTitle = if ($frame) { $frame.title } else { $null }
  $info.sonar = [ordered]@{
    found = $true
    hwnd  = $hMain.ToInt64().ToString('X8')
    pid   = $tid
    title = $frameTitle
    documentTab = Get-DocumentTab $hMain $frameTitle
  }
  $info.windows = $interesting | ForEach-Object { [ordered]@{ hwnd = $_.hwndHex; cls = $_.cls; title = $_.title } }
  # Full visible list, so a caller can diff before/after a menu command and tell
  # a command that did nothing from one that opened a dialog or a panel.
  $info.allWindows = @($wins | Where-Object { $_.visible } | ForEach-Object {
    [ordered]@{ hwnd = $_.hwndHex; cls = $_.cls; title = $_.title }
  })
  $info.overlays = Get-Overlays $tid | ForEach-Object { [ordered]@{ hwnd = $_.hwndHex; cls = $_.cls; title = $_.title } }
  $llm = $interesting | Where-Object { $_.cls -match 'XCD|LLM' }
  if ($llm) {
    $info.assistant = [ordered]@{ found = $true; hwnd = $llm[0].hwndHex; cls = $llm[0].cls; transport = 'window-message' }
  } else {
    $info.assistant = [ordered]@{
      found     = $false
      transport = 'wm-command'
      hint      = 'No XCD*/LLM* window (the AI-Assistant transport is unavailable in this build). Menu-command transport still works: see the runmenu op.'
    }
  }
  return (ConvertTo-Json -Depth 8 -Compress $info)
}

# Every response carries the request id it answers. Without this the Node side
# matched responses to requests FIFO, so one timed-out call shifted every later
# answer onto the wrong caller (measured: a 1 ms msgids probe plus a 15 s call made
# the next one receive the previous one's payload).
$script:rid = $null
function Emit($obj) {
  if ($obj -is [string]) {
    try { $obj = $obj | ConvertFrom-Json } catch { $obj = [ordered]@{ raw = $obj } }
  }
  if ($obj -is [System.Collections.IDictionary]) { $obj['id'] = $script:rid }
  else { $obj | Add-Member -NotePropertyName id -NotePropertyValue $script:rid -Force }
  Write-Output (ConvertTo-Json -Depth 12 -Compress $obj)
}

# ---- main loop: JSON lines on stdin ----
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $req = ConvertFrom-Json $line
    $script:rid = $req.id
    switch ($req.op) {
      'status' { Emit (Get-Status) }

      'probe' {
        $hwndHex = ([string]$req.hwnd) -replace '^0[xX]', ''
        $hwnd = New-Object IntPtr ([Convert]::ToInt64($hwndHex, 16))
        $msgId = [CwBridge]::RegisterWindowMessageW($req.msg)
        $r = Send-Json $hwnd $msgId $req.json
        Emit @{ msg = $req.msg; msgId = $msgId; result = $r }
      }

      'msgids' {
        $ids = [ordered]@{}
        foreach ($m in $req.names) { $ids[$m] = [CwBridge]::RegisterWindowMessageW($m) }
        Emit $ids
      }

      'menu' {
        $h = Find-SonarMain
        if ($h -eq [IntPtr]::Zero) { Emit @{ error = 'sonar not running' }; continue }
        $tree = Get-MenuTree $h ([CwBridge]::GetMenu($h)) 0
        Emit @{ menu = $tree }
      }

      'runmenu' {
        $h = Find-SonarMain
        if ($h -eq [IntPtr]::Zero) { Emit @{ error = 'sonar not running' }; continue }
        # Modal overlays (the Assistant / command-palette JUCE panel) swallow
        # WM_COMMAND, so close them first unless the caller asked us not to.
        $closed = @()
        if (-not $req.keepOverlays) {
          $tid = 0
          [CwBridge]::GetWindowThreadProcessId($h, [ref]$tid) | Out-Null
          foreach ($ov in (Get-Overlays $tid)) {
            # Same rule as the overlays branch: a #32770 is a real Win32 dialog
            # (a file picker, or a "save your changes?" prompt whose WM_CLOSE
            # usually means discard). Only JUCE panels are closed automatically.
            if ($ov.cls -eq '#32770' -and -not $req.closeDialogs) { continue }
            $oh = New-Object IntPtr ([Convert]::ToInt64($ov.hwndHex, 16))
            [CwBridge]::PostMessageW($oh, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
            $closed += $ov.hwndHex
          }
          if ($closed.Count -gt 0) { Start-Sleep -Milliseconds 700 }
        }
        [CwBridge]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 250
        $cmdId = [int64]$req.cmdId
        [CwBridge]::PostMessageW($h, 0x0111, [IntPtr]$cmdId, [IntPtr]::Zero) | Out-Null
        Emit @{ posted = $cmdId; cmdHex = '0x' + $cmdId.ToString('X4'); closedOverlays = $closed }
      }

      'overlays' {
        $h = Find-SonarMain
        if ($h -eq [IntPtr]::Zero) { Emit @{ error = 'sonar not running' }; continue }
        $tid = 0
        [CwBridge]::GetWindowThreadProcessId($h, [ref]$tid) | Out-Null
        $ov = Get-Overlays $tid
        $closed = @()
        # Declared outside the branch: when close was not requested these stay
        # empty, and the response still reports counts of 0 rather than $null.
        $attempted = @()
        if ($req.close) {
          # Only windows we actually posted WM_CLOSE to are candidates. A
          # retained #32770 (closeDialogs not set) was never attempted, so it can
          # never be reported as closed — that is how a "save your changes?"
          # prompt used to be counted while still on screen.
          foreach ($o in $ov) {
            # A #32770 is a real Win32 dialog — an Open/Save file picker or, worse,
            # a "save your changes?" prompt. Closing one with WM_CLOSE is a user
            # decision (and on a save prompt it usually means "discard"). Only
            # JUCE panels are closed automatically; #32770 needs closeDialogs.
            if ($o.cls -eq '#32770' -and -not $req.closeDialogs) { continue }
            $oh = New-Object IntPtr ([Convert]::ToInt64($o.hwndHex, 16))
            # PostMessageW only queues the request; it returns whether the message
            # was dispatched, not whether the window went away. That is why the
            # outcome is decided by re-enumerating below, never by this result.
            [CwBridge]::PostMessageW($oh, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
            $attempted += $o.hwndHex
          }
          # Re-read after the attempts so "overlays" means what remains, not what
          # was seen before the request, and so "closed" means observed gone: a
          # handle we posted to must be ABSENT from the fresh list. A panel that
          # ignored WM_CLOSE (refused), or that is still on screen (retained),
          # stays in $ov and is therefore not counted.
          if ($attempted.Count -gt 0) {
            Start-Sleep -Milliseconds 300
            $ov = Get-Overlays $tid
            $still = @()
            foreach ($o in $ov) { $still += $o.hwndHex }
            foreach ($a in $attempted) { if ($still -notcontains $a) { $closed += $a } }
          }
        }
        Emit @{
          overlays = @($ov)
          closed = ($closed.Count -gt 0)
          closedCount = $closed.Count
          attemptedCount = @($attempted).Count
          requested = [bool]$req.close
        }
      }

      'quit' { exit 0 }
      default { Emit @{ error = "unknown op: $($req.op)" } }
    }
  } catch {
    Emit @{ error = $_.Exception.Message }
  }
}
`;

let child = null;
const inflight = [];
let nextId = 1;

// PowerShell writes informational records to stderr as well as errors; only
// forward lines that look like real failures so the MCP log stays readable.
const NOISE = /^\s*($|#< CLIXML|At line:|CategoryInfo|FullyQualifiedErrorId)/;
function forwardStderr(tag, chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (!line.trim() || NOISE.test(line)) continue;
    process.stderr.write(`[${tag}] ${line}\n`);
  }
}

export function startBridge() {
  if (child) return child;
  child = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.id !== undefined && msg.id !== null) {
          const i = inflight.findIndex((e) => e.id === msg.id);
          if (i >= 0) {
            const [entry] = inflight.splice(i, 1);
            delete msg.id;
            entry.resolve(msg);
          }
          // an id nobody waits for (a timed-out call that finally answered) is
          // dropped rather than handed to an unrelated caller
        }
      } catch (_) { /* ignore non-json noise */ }
    }
  });
  child.stderr.on('data', (c) => forwardStderr('bridge', c));
  // Same reason as bridge/midi.js: an unhandled spawn 'error' becomes an uncaught
  // exception, and every pending call waits out its full timeout instead of being
  // told why. On a non-Windows host this is the first thing that happens.
  child.on('error', (e) => {
    child = null;
    const reason = e.code === 'ENOENT'
      ? 'powershell.exe was not found. This adapter drives SONAR through Windows '
        + 'PowerShell 5.1, so it only runs on Windows with PowerShell installed.'
      : `the PowerShell bridge failed to start: ${e.message}`;
    for (const entry of inflight.splice(0)) {
      const err = new Error(reason);
      err.code = e.code === 'ENOENT' ? 'NO_POWERSHELL' : 'BRIDGE_START_FAILED';
      entry.reject(err);
    }
  });
  child.stdin.on('error', () => {});
  child.on('exit', (code) => {
    child = null;
    for (const e of inflight.splice(0)) e.reject(new Error(`bridge exited (code=${code})`));
  });
  return child;
}

export function call(op, extra = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!child) startBridge();
    const msg = Object.assign({ op }, extra);
    const entry = { resolve, reject, id: nextId++ };
    inflight.push(entry);
    msg.id = entry.id;
    child.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      const i = inflight.indexOf(entry);
      if (i >= 0) {
        inflight.splice(i, 1);
        reject(new Error(`bridge call '${op}' timed out`));
      }
    }, timeoutMs);
  });
}

export function stopBridge() {
  if (child) {
    try { child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); } catch (_) {}
    setTimeout(() => { try { child && child.kill(); } catch (_) {} }, 500);
  }
}
