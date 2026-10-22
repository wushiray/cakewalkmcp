// test/helpers.mjs — shared fixtures and assertions for the white-box suite.
//
// No test framework beyond node:test — this project has exactly two runtime
// dependencies (the MCP SDK and zod) and adding a test runner would be a third.
// node:test has been stable since Node 18 and gives better failure output than a
// hand-rolled harness.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = null;

/** A scratch directory that the suite removes on exit. */
export function scratch() {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'cw-test-'));
    process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  }
  return dir;
}

/**
 * Tear down the long-lived shims a test may have started.
 *
 * documentState() and anything calling cw_status will start the PowerShell
 * bridge, which stays alive by design. A test process that leaves it running
 * exits slowly and, worse, the leftover process competes for CPU with the next
 * test file — which showed up as a 60-second timeout on a suite whose tests each
 * took about a second in isolation. Registering this once means a test can call
 * a bridge-backed function without thinking about it.
 */
export async function shutdownShims() {
  try {
    const { stopBridge } = await import('../bridge/agent.js');
    stopBridge();
  } catch (_) { /* module may not have been loaded */ }
  try {
    const { stopMidi } = await import('../bridge/midi.js');
    stopMidi();
  } catch (_) { /* likewise */ }
  // stopBridge() signals and then kills on a 500ms timer; give it that long so
  // the child is gone before the test runner reports exit.
  await new Promise((r) => setTimeout(r, 700));
}

if (!globalThis.__cwShimsRegistered) {
  // Nothing to do synchronously at exit — the async helper above is the one to
  // call. The flag exists so a future addition can hang a once-only teardown
  // here without every test file re-registering it.
  globalThis.__cwShimsRegistered = true;
}

export function tempFile(name, contents) {
  const p = join(scratch(), name);
  if (contents !== undefined) writeFileSync(p, contents);
  return p;
}

/** Assert two MIDI byte arrays are equal, with a readable diff. */
export function bytesEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) return false;
  return true;
}

export function hexBytes(arr) {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** A realistic `reg query /v clsidPlug` reply, for parser tests. */
export const SAMPLE_CLSID_QUERY = `
HKEY_CURRENT_USER\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory\\c:/program files/common files/VST3/2B Crushed/2B Crushed.vst3*0 2B Crushed
    clsidPlug    REG_SZ    {86FEB0B3-2BAA-4426-90AF-C6072DE284E5}
`;

/** A realistic top-level `reg query` reply: subkey names only, no values. */
export const SAMPLE_INVENTORY_KEYNAMES = `
HKEY_CURRENT_USER\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory
HKEY_CURRENT_USER\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory\\c:/program files/common files/VST3/2B Crushed/2B Crushed.vst3
HKEY_CURRENT_USER\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory\\c:/program files/common files/VST3/2B Crushed/2B Crushed.vst3*0 2B Crushed
HKEY_CURRENT_USER\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory\\d:/CAKEWALK/Boost11/Boost11_64.dll
HKEY_CURRENT_USER\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory\\d:/CAKEWALK/SI-Drum Kit/SI-Drum Kit.dll
HKEY_CURRENT_USER\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory\\c:/vst/EZdrummer.dll*0 EZdrummer 3
HKEY_CURRENT_USER\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory\\c:/vst/uaudio_pultec.vst3/Contents/x86_64-win/uaudio_pultec.vst3*12 UADx Pultec EQP-1A EQ
`;

/** A realistic plugin menu layout fragment. */
export const SAMPLE_LAYOUT = `<?xml version="1.0" encoding="UTF-8"?>
<PluginMenuLayout DocSchema="1" Name="Test">
<Folder Name="Dynamics"><Plugin ID="1" CLSID="{AAAA0000-0000-0000-0000-000000000001}" Category="11" Name="Compander" OriginalName="Compander"/><Plugin ID="2" CLSID="{BBBB0000-0000-0000-0000-000000000002}" Category="0" Name="Compressor/Gate" OriginalName="CompGate"/></Folder>
<Folder Name="Reverb"><Plugin ID="3" CLSID="{CCCC0000-0000-0000-0000-000000000003}" Category="11" Name="Vocal Verb" OriginalName="Vocal Verb"/></Folder>
</PluginMenuLayout>
`;

/** A realistic TTSSEQ.INI. */
export const SAMPLE_TTSSEQ = `[MIDI Input Devices]
0=Steinberg UR22C-1
1=Studio One AI Notes
MaxInPort=1
[MIDI Output Devices]
0=Steinberg UR22C-1
1=Studio One AI Notes
MaxOutPort=1
[MIDI Echo Devices]
MaxEchoPort=-1
`;
