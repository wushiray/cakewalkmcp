// bridge/loopback.js — open a MIDI port's input side and capture what arrives.
//
// This is how the live transport is verified end to end without SONAR's UI. A
// loopMIDI cable appears as both an OUT and an IN port under one name; writing
// to the OUT side and reading the IN side proves the cable, the winmm path and
// the message encoding all work. SONAR's own receive is then confirmed
// separately by reading TTSSEQ.INI (see lib/midi-config.js), because a running
// SONAR gives no direct feedback for an unarmed input.
//
// Implemented with a callback rather than polling: midiInOpen takes a function
// pointer, so the shim installs a delegate and prints each message as it lands.
// That also makes latency measurable.

import { spawn } from 'node:child_process';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Midin {
  [DllImport("winmm.dll")] public static extern uint midiInGetNumDevs();
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct MIDIINCAPS {
    public ushort wMid, wPid; public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;
    public uint dwSupport;
  }
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)]
  public static extern uint midiInGetDevCapsW(uint id, ref MIDIINCAPS caps, uint size);
  public delegate void MidiInProc(IntPtr h, uint msg, IntPtr inst, IntPtr p1, IntPtr p2);
  [DllImport("winmm.dll")] public static extern uint midiInOpen(out IntPtr h, uint id, MidiInProc cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] public static extern uint midiInStart(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint midiInStop(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint midiInClose(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint midiInReset(IntPtr h);
}
'@

$script:handle = [IntPtr]::Zero
$script:received = New-Object System.Collections.Generic.List[object]

# Keep the delegate alive for the process lifetime; a collected callback would
# crash the driver the moment a message arrives.
$script:proc = [Midin+MidiInProc]{
  param($h, $msg, $inst, $p1, $p2)
  # MIM_DATA = 0x3C3
  if ($msg -eq 0x3C3) {
    $m = [int64]$p1
    $status = $m -band 0xFF
    $d1 = ($m -shr 8) -band 0x7F
    $d2 = ($m -shr 16) -band 0x7F
    $script:received.Add([pscustomobject]@{
      t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      status = $status; data1 = $d1; data2 = $d2
    }) | Out-Null
  }
}

function Resolve-In {
  param([string] $Name)
  $n = [Midin]::midiInGetNumDevs()
  for ($i = 0; $i -lt $n; $i++) {
    $c = New-Object Midin+MIDIINCAPS
    [Midin]::midiInGetDevCapsW([uint32]$i, [ref]$c, [uint32][Runtime.InteropServices.Marshal]::SizeOf($c)) | Out-Null
    if ($c.szPname -like "*$Name*") { return [pscustomobject]@{ index = $i; name = $c.szPname } }
  }
  return $null
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $req = ConvertFrom-Json $line
    switch ($req.op) {
      'open' {
        if ($script:handle -ne [IntPtr]::Zero) { [Midin]::midiInClose($script:handle) | Out-Null; $script:handle = [IntPtr]::Zero }
        $p = Resolve-In $req.name
        if (-not $p) { Write-Output (ConvertTo-Json -Compress @{ ok=$false; error="no MIDI input matching '$($req.name)'" }); continue }
        $h = [IntPtr]::Zero
        $rc = [Midin]::midiInOpen([ref]$h, [uint32]$p.index, $script:proc, [IntPtr]::Zero, 0x30000)  # CALLBACK_FUNCTION
        if ($rc -ne 0) { Write-Output (ConvertTo-Json -Compress @{ ok=$false; error="midiInOpen rc=$rc" }); continue }
        $script:handle = $h
        $script:received.Clear()
        [Midin]::midiInStart($h) | Out-Null
        Write-Output (ConvertTo-Json -Compress @{ ok=$true; port=$p.name; index=$p.index })
      }
      'collect' {
        # Drain and return what arrived since the last collect. Messages are
        # sent as a flat array of 4-element arrays; ConvertTo-Json would flatten
        # them, so encode each one as a single string "status,data1,data2,ms" and
        # split on the Node side.
        $items = @($script:received)
        $script:received.Clear()
        $flat = @()
        foreach ($m in $items) { $flat += ('{0},{1},{2},{3}' -f $m.status, $m.data1, $m.data2, $m.t) }
        Write-Output (ConvertTo-Json -Compress @{ count=$flat.Count; raw=$flat })
      }
      'close' {
        if ($script:handle -ne [IntPtr]::Zero) {
          [Midin]::midiInStop($script:handle) | Out-Null
          [Midin]::midiInReset($script:handle) | Out-Null
          [Midin]::midiInClose($script:handle) | Out-Null
          $script:handle = [IntPtr]::Zero
        }
        Write-Output (ConvertTo-Json -Compress @{ ok=$true })
      }
      'quit' {
        if ($script:handle -ne [IntPtr]::Zero) { [Midin]::midiInStop($script:handle) | Out-Null; [Midin]::midiInClose($script:handle) | Out-Null }
        exit 0
      }
      default { Write-Output (ConvertTo-Json -Compress @{ error="unknown op: $($req.op)" }) }
    }
  } catch {
    Write-Output (ConvertTo-Json -Compress @{ error=$_.Exception.Message })
  }
}
`;

let child = null;
const inflight = [];

export function startLoopback() {
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
        const entry = inflight.shift();
        if (entry) entry.resolve(msg);
      } catch (_) { /* ignore noise */ }
    }
  });
  child.stderr.on('data', () => { /* winmm is quiet unless something is wrong */ });
  child.on('error', (cause) => {
    child = null;
    const e = new Error(`loopback shim could not start: ${cause.message}`);
    e.code = 'NO_POWERSHELL';
    for (const entry of inflight.splice(0)) entry.reject(e);
  });
  child.stdin.on('error', () => { /* process error/exit settles the pending calls */ });
  child.on('exit', (code) => {
    child = null;
    for (const e of inflight.splice(0)) e.reject(new Error(`loopback shim exited (code=${code})`));
  });
  return child;
}

export function loopbackCall(op, extra = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!child) startLoopback();
    const entry = { resolve, reject };
    inflight.push(entry);
    child.stdin.write(JSON.stringify(Object.assign({ op }, extra)) + '\n');
    setTimeout(() => {
      const i = inflight.indexOf(entry);
      if (i >= 0) { inflight.splice(i, 1); reject(new Error(`loopback '${op}' timed out`)); }
    }, timeoutMs);
  });
}

export const openCapture = (name) => loopbackCall('open', { name });
export const closeCapture = () => loopbackCall('close');

/** Drain captured messages as [{ status, data1, data2, ms }]. */
export async function collect() {
  const r = await loopbackCall('collect');
  const raw = r.raw === null || r.raw === undefined ? [] : (Array.isArray(r.raw) ? r.raw : [r.raw]);
  const messages = raw.map((s) => {
    const [status, data1, data2, ms] = String(s).split(',').map(Number);
    return { status, data1, data2, ms };
  });
  return { count: messages.length, messages };
}

export function stopLoopback() {
  if (child) {
    try { child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); } catch (_) {}
    setTimeout(() => { try { child && child.kill(); } catch (_) {} }, 500);
  }
}
