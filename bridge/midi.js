// bridge/midi.js — real-time MIDI output from Node, via a small PowerShell shim.
//
// Why MIDI at all: on SONAR builds that dropped the CakeScript transport (see
// README, 2026.10) MIDI is the remaining way to *change* a project rather than
// just open dialogs. A loopMIDI virtual cable is a real Windows MIDI device, so
// whatever we send to its OUT port arrives at SONAR's IN port — no IPC, no
// scripting engine, and latency in the low milliseconds.
//
// The shim is a separate long-lived PowerShell process from the user32 bridge,
// because winmm handles are process-scoped: opening the port once and reusing
// the handle across calls is what keeps send latency flat.

import { spawn } from 'node:child_process';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class MidiShim {
  [DllImport("winmm.dll")] public static extern uint midiOutGetNumDevs();
  [DllImport("winmm.dll")] public static extern uint midiInGetNumDevs();
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct MIDIOUTCAPS {
    public ushort wMid, wPid; public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;
    public ushort wTechnology, wVoices, wNotes, wChannelMask; public uint dwSupport;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct MIDIINCAPS {
    public ushort wMid, wPid; public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;
    public uint dwSupport;
  }
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)]
  public static extern uint midiOutGetDevCapsW(uint id, ref MIDIOUTCAPS caps, uint size);
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)]
  public static extern uint midiInGetDevCapsW(uint id, ref MIDIINCAPS caps, uint size);
  // Packed 4-byte message: status | data1<<8 | data2<<16
  [DllImport("winmm.dll")] public static extern uint midiOutOpen(out IntPtr h, uint id, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] public static extern uint midiOutClose(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint midiOutShortMsg(IntPtr h, uint msg);
  [DllImport("winmm.dll")] public static extern uint midiOutReset(IntPtr h);
}
'@

function Get-Devices {
  $out = New-Object System.Collections.Generic.List[object]
  $no = [MidiShim]::midiOutGetNumDevs()
  for ($i = 0; $i -lt $no; $i++) {
    $c = New-Object MidiShim+MIDIOUTCAPS
    [MidiShim]::midiOutGetDevCapsW([uint32]$i, [ref]$c, [uint32][Runtime.InteropServices.Marshal]::SizeOf($c)) | Out-Null
    $out.Add([pscustomobject]@{ index = $i; dir = 'out'; name = $c.szPname }) | Out-Null
  }
  $ni = [MidiShim]::midiInGetNumDevs()
  for ($i = 0; $i -lt $ni; $i++) {
    $c = New-Object MidiShim+MIDIINCAPS
    [MidiShim]::midiInGetDevCapsW([uint32]$i, [ref]$c, [uint32][Runtime.InteropServices.Marshal]::SizeOf($c)) | Out-Null
    $out.Add([pscustomobject]@{ index = $i; dir = 'in'; name = $c.szPname }) | Out-Null
  }
  return $out
}

# Resolve a port by name substring, preferring an OUT port.
function Resolve-Port {
  param([string] $Name)
  foreach ($d in Get-Devices) {
    if ($d.dir -eq 'out' -and $d.name -like "*$Name*") { return $d }
  }
  foreach ($d in Get-Devices) {
    if ($d.dir -eq 'in' -and $d.name -like "*$Name*") { return $d }
  }
  return $null
}

$script:handle = [IntPtr]::Zero
$script:openName = $null

# Responses carry the request id they answer. FIFO matching meant one timed-out
# call shifted every later reply onto the wrong caller (measured: a 1 ms timeout
# made the next send return a device list).
$script:rid = $null
function Emit($obj) {
  if ($obj -is [System.Collections.IDictionary]) { $obj['id'] = $script:rid }
  else { $obj | Add-Member -NotePropertyName id -NotePropertyValue $script:rid -Force }
  Write-Output (ConvertTo-Json -Depth 8 -Compress $obj)
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $req = ConvertFrom-Json $line
    $script:rid = $req.id
    switch ($req.op) {
      'devices' {
        Emit @{ devices = @(Get-Devices) }
      }
      'open' {
        if ($script:handle -ne [IntPtr]::Zero) { [MidiShim]::midiOutClose($script:handle) | Out-Null; $script:handle = [IntPtr]::Zero }
        $p = Resolve-Port $req.name
        if (-not $p) { Emit @{ ok = $false; error = "no MIDI port matching '$($req.name)'" }; continue }
        if ($p.dir -ne 'out') { Emit @{ ok = $false; error = "'$($p.name)' is an input port; need an output port" }; continue }
        $h = [IntPtr]::Zero
        $rc = [MidiShim]::midiOutOpen([ref]$h, [uint32]$p.index, [IntPtr]::Zero, [IntPtr]::Zero, 0)
        if ($rc -ne 0) { Emit @{ ok = $false; error = "midiOutOpen rc=$rc"; port = $p.name }; continue }
        $script:handle = $h
        $script:openName = $p.name
        Emit @{ ok = $true; port = $p.name; index = $p.index }
      }
      'send' {
        if ($script:handle -eq [IntPtr]::Zero) { Emit @{ ok = $false; error = 'no port open' }; continue }
        # status/data1/data2 -> packed uint
        $msg = [uint32]$req.status -bor ([uint32]$req.data1 -shl 8) -bor ([uint32]$req.data2 -shl 16)
        $rc = [MidiShim]::midiOutShortMsg($script:handle, $msg)
        Emit @{ ok = ($rc -eq 0); rc = $rc; msg = $msg }
      }
      'sendraw' {
        if ($script:handle -eq [IntPtr]::Zero) { Emit @{ ok = $false; error = 'no port open' }; continue }
        $n = 0
        $failed = 0
        $firstRc = $null
        foreach ($m in $req.messages) {
          $msg = [uint32]$m[0] -bor ([uint32]$m[1] -shl 8) -bor ([uint32]$m[2] -shl 16)
          # midiOutShortMsg returns 0 on success. The old code threw the result
          # away and counted every message as sent, so a driver that rejected
          # all of them still reported ok:true.
          $rc = [MidiShim]::midiOutShortMsg($script:handle, $msg)
          if ($rc -ne 0) { $failed++; if ($null -eq $firstRc) { $firstRc = $rc } }
          $n++
        }
        Emit @{
          ok = ($failed -eq 0)
          sent = ($n - $failed)
          attempted = $n
          failed = $failed
          rc = $firstRc
          error = $(if ($failed -gt 0) { "midiOutShortMsg failed for $failed of $n message(s), rc=$firstRc" } else { $null })
        }
      }
      'panic' {
        # midiOutReset returns MMRESULT: 0 (MMSYSERR_NOERROR) is the ONLY success.
        # The old code discarded the result and always answered ok:true, so a
        # panic that the driver refused looked identical to a real all-notes-off,
        # and a panic with no open port claimed success without doing anything.
        if ($script:handle -eq [IntPtr]::Zero) {
          Emit @{ ok = $false; code = 'NO_PORT_OPEN'; error = 'no port open: midiOutReset was not called' }
          continue
        }
        $rc = [MidiShim]::midiOutReset($script:handle)
        Emit @{
          ok = ($rc -eq 0)
          rc = $rc
          code = $(if ($rc -eq 0) { $null } else { 'MIDI_RESET_FAILED' })
          error = $(if ($rc -eq 0) { $null } else { "midiOutReset failed: rc=$rc" })
        }
      }
      'close' {
        if ($script:handle -ne [IntPtr]::Zero) { [MidiShim]::midiOutClose($script:handle) | Out-Null; $script:handle = [IntPtr]::Zero }
        Emit @{ ok = $true }
      }
      'quit' {
        if ($script:handle -ne [IntPtr]::Zero) { [MidiShim]::midiOutClose($script:handle) | Out-Null }
        exit 0
      }
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

export function startMidi() {
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
        }
      } catch (_) { /* ignore non-json noise */ }
    }
  });
  child.stderr.on('data', (c) => process.stderr.write(`[midi] ${c}`));
  // A failed spawn emits 'error', and an unhandled one is thrown as an uncaught
  // exception. Measured on Linux: the server printed a raw ENOENT stack trace and
  // every MIDI call then hung until its timeout. Attribute the failure instead.
  child.on('error', (e) => {
    child = null;
    const reason = e.code === 'ENOENT'
      ? 'powershell.exe was not found. This adapter drives SONAR through Windows '
        + 'PowerShell 5.1, so it only runs on Windows with PowerShell installed.'
      : `the MIDI shim failed to start: ${e.message}`;
    for (const entry of inflight.splice(0)) {
      const err = new Error(reason);
      err.code = e.code === 'ENOENT' ? 'NO_POWERSHELL' : 'BRIDGE_START_FAILED';
      entry.reject(err);
    }
  });
  // Writing to a child that never started raises EPIPE on the stream, which is
  // itself an unhandled 'error' event. The 'error' handler above reports the
  // real cause; this one only keeps the pipe from throwing.
  child.stdin.on('error', () => {});
  child.on('exit', (code) => {
    child = null;
    for (const e of inflight.splice(0)) e.reject(new Error(`midi shim exited (code=${code})`));
  });
  return child;
}

export function midiCall(op, extra = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!child) startMidi();
    const entry = { resolve, reject, id: nextId++ };
    inflight.push(entry);
    const msg = Object.assign({ op }, extra, { id: entry.id });
    child.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      const i = inflight.indexOf(entry);
      if (i >= 0) { inflight.splice(i, 1); reject(new Error(`midi call '${op}' timed out`)); }
    }, timeoutMs);
  });
}

// --- MIDI message helpers ---------------------------------------------------
// Status bytes: 0x9n note on, 0x8n note off, 0xBn control change, 0xEn pitch bend.

export const CH = (n) => Math.max(0, Math.min(15, (n | 0) - 1));

export const noteOn = (channel, pitch, velocity) =>
  [0x90 | CH(channel), pitch & 0x7f, velocity & 0x7f];

export const noteOff = (channel, pitch) =>
  [0x80 | CH(channel), pitch & 0x7f, 0];

export const controlChange = (channel, controller, value) => {
  // An undefined controller silently became CC0 via the bit-mask, which is a
  // wrong-but-plausible message rather than an error. Refuse instead.
  if (!Number.isFinite(Number(controller))) {
    throw new TypeError(`controlChange: controller must be a number, got ${controller}`);
  }
  return [0xb0 | CH(channel), Number(controller) & 0x7f, value & 0x7f];
};

export const pitchBend = (channel, value14) => {
  const v = Math.max(0, Math.min(16383, value14 | 0));
  return [0xe0 | CH(channel), v & 0x7f, (v >> 7) & 0x7f];
};

// Common CC numbers for mixer work.
/**
 * Common CC numbers for mixer work.
 *
 * Exported under BOTH cases on purpose. midi-file.js uses `CC.pan`, mixer.js used
 * `CC.PAN`, and a mismatch between the two is silent rather than loud: an
 * undefined controller number becomes 0 in the bit-mask, so `controlChange(ch,
 * undefined, 64)` sends CC0 (bank select) instead of CC10 (pan) and the mix
 * lands on the wrong parameter with no error anywhere. Two spellings of the same
 * table removes the whole class of mistake.
 */
const CC_NUMBERS = {
  BANK_SELECT_MSB: 0,
  MODULATION: 1,
  BREATH: 2,
  VOLUME: 7,        // channel volume — the usual "track fader" CC
  PAN: 10,          // channel pan
  EXPRESSION: 11,
  SUSTAIN: 64,
  REVERB: 91,
  CHORUS: 93,
  ALL_SOUND_OFF: 120,
  RESET_ALL_CONTROLLERS: 121,
  ALL_NOTES_OFF: 123,
};

export const CC = CC_NUMBERS;
// Lower-case aliases so `CC.pan` and `CC.PAN` both resolve to 10.
export const ccNumbers = {
  bankSelect: CC_NUMBERS.BANK_SELECT_MSB,
  modulation: CC_NUMBERS.MODULATION,
  breath: CC_NUMBERS.BREATH,
  volume: CC_NUMBERS.VOLUME,
  pan: CC_NUMBERS.PAN,
  expression: CC_NUMBERS.EXPRESSION,
  sustain: CC_NUMBERS.SUSTAIN,
  reverb: CC_NUMBERS.REVERB,
  chorus: CC_NUMBERS.CHORUS,
  allSoundOff: CC_NUMBERS.ALL_SOUND_OFF,
  resetAllControllers: CC_NUMBERS.RESET_ALL_CONTROLLERS,
  allNotesOff: CC_NUMBERS.ALL_NOTES_OFF,
};
// Attach the lower-case names to CC itself, so one import covers both spellings.
for (const [k, v] of Object.entries(ccNumbers)) CC[k] = v;

export const listDevices = () => midiCall('devices');
export const openPort = (name) => midiCall('open', { name });
export const closePort = () => midiCall('close');
export const panic = () => midiCall('panic');

/** Send one 3-byte message given as [status, data1, data2]. */
export async function send([status, data1 = 0, data2 = 0]) {
  return midiCall('send', { status, data1, data2 });
}

/** Send a batch in one round trip — use this for chords and multi-note edits. */
export async function sendAll(messages) {
  return midiCall('sendraw', { messages }, 15000);
}

/** Play a note with a real note-off after `durationMs`. */
export async function playNote(channel, pitch, velocity, durationMs) {
  await sendAll([noteOn(channel, pitch, velocity)]);
  await new Promise((r) => setTimeout(r, durationMs));
  await sendAll([noteOff(channel, pitch)]);
}

export function stopMidi() {
  if (child) {
    try { child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); } catch (_) {}
    setTimeout(() => { try { child && child.kill(); } catch (_) {} }, 500);
  }
}
