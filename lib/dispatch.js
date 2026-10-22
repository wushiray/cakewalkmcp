// lib/dispatch.js — one entry point that picks the transport SONAR supports.
//
// SONAR's automation surface has moved between builds, so nothing here assumes
// a single mechanism. Three transports exist, best first:
//
//   T1  window-message
//       The AI-Assistant IPC: a `XCDLLMSERVER` window plus messages registered
//       at runtime with RegisterWindowMessage (the `--*LLM_*--` names are ids,
//       not literals — they do not appear in the binary as strings, which is
//       why a byte scan for them finds nothing). Fastest and the only transport
//       that returns structured Lua results, but the window is only created by
//       builds that still ship the Assistant panel. Present in 2026.08
//       (32.08.0.040); absent in 2026.10 (32.10.0.021).
//
//   T2  wm-command
//       The Win32 menu bar, driven by WM_COMMAND with ids read live from
//       GetMenuItemID. Version-independent because it reads the running build's
//       own menu, and fire-and-forget: it starts processes and toggles views
//       with no result payload.
//
//       CakeScript IS reachable through T2 on 2026.10 — `处理 > 运行 CakeScript
//       程序` is command 42893 and it responds. What it opens is the membership
//       panel: the CakeScript engine (sol2 + Lua 5.4, `CakeScript::ITrack`,
//       `IMIDIEventAdv`, … all present in the binary) is complete and compiled
//       in, but running a script is gated behind a paid membership on a free
//       licence. That is a licensing boundary, not a missing feature — the
//       distinction matters because the gate can be lifted without a rebuild.
//
//   T3  computer-use
//       Not implemented here. This process cannot drive the GUI; a caller that
//       has a computer-use runtime must do it. We only report that it is the
//       remaining option, with the concrete steps.
//
// `capabilities()` is the single source of truth other modules and cw_status
// read, so the reported state always matches what execution will try.

import { call } from '../bridge/agent.js';
import { findSonar, sonarVersion, isSonarRunning } from './sonar.js';
import { liveCommands, commandIndexPath, assertCommandAllowed } from './menu.js';

export const TRANSPORTS = {
  WINDOW_MESSAGE: 'window-message',
  WM_COMMAND: 'wm-command',
  COMPUTER_USE: 'computer-use',
};

/**
 * Which transports this SONAR build supports, and why the others do not.
 * Cached per process; pass { refresh: true } to re-probe after the user opens
 * the Assistant panel.
 */
let capCache = null;
let capAt = 0;
// Same reason as menuTree: a cached "SONAR is not running" must not outlive the
// launch of SONAR. cw_status passes refresh:true; everything else recovers here.
const CAP_TTL_MS = 3000;

export async function capabilities({ refresh = false } = {}) {
  if (capCache && !refresh && Date.now() - capAt < CAP_TTL_MS) return capCache;

  const exePath = findSonar();
  const running = isSonarRunning();
  const version = exePath ? sonarVersion(exePath) : null;
  const build = version && version.FileVersion ? version.FileVersion : null;

  const out = {
    sonar: { path: exePath, running, version, build },
    transports: {},
    recommended: null,
    notes: [],
  };

  if (!running) {
    // Every transport is reported, explicitly unavailable. Leaving `transports`
    // empty here made runCommand() and cakeScriptBlocker() dereference undefined
    // and throw a raw TypeError at the caller — so the one case a user hits most
    // often (SONAR simply not started) produced a JavaScript internal error
    // instead of the documented CAKESCRIPT_UNAVAILABLE with its alternatives.
    // A capabilities object is a promise that every key it names is readable.
    for (const [key, why] of [
      [TRANSPORTS.WINDOW_MESSAGE, 'SONAR is not running.'],
      [TRANSPORTS.WM_COMMAND, 'SONAR is not running, so there is no menu bar to read.'],
      [TRANSPORTS.COMPUTER_USE, 'SONAR is not running; nothing is on screen to drive yet.'],
    ]) {
      out.transports[key] = { available: false, detail: why };
    }
    out.notes.push('SONAR is not running; start it and open a project.');
    out.recommended = null;
    capCache = out; capAt = Date.now();
    return out;
  }

  // Probe T1: is there an XCD*/LLM* window?
  let status = null;
  try { status = await call('status'); } catch (e) { out.notes.push(`bridge status failed: ${e.message}`); }
  const assistantFound = !!(status && status.assistant && status.assistant.found);

  out.transports[TRANSPORTS.WINDOW_MESSAGE] = {
    available: false,
    detected: assistantFound,
    implemented: false,
    detail: assistantFound
      ? `Assistant window ${status.assistant.cls} detected; T1 IPC is not implemented by this adapter`
      : 'No XCDLLMSERVER window. This is the only unattended route to CakeScript, and it '
        + 'exists only in builds that still ship the Assistant panel. Its absence does NOT '
        + 'mean the engine is missing — 2026.10 has it compiled in and gated (see '
        + 'cakeScriptBlocker, and 处理 > 运行 CakeScript 程序 = command 42893).',
  };

  // Probe T2: does the live menu expose commands we can post?
  let liveCount = 0;
  try {
    const live = await liveCommands();
    liveCount = live.length;
  } catch (_) { /* menu probe is best-effort */ }
  out.transports[TRANSPORTS.WM_COMMAND] = {
    available: liveCount > 0,
    detail: liveCount > 0
      ? `${liveCount} commands readable from the live menu bar`
      : 'Could not read the menu bar.',
  };

  out.transports[TRANSPORTS.COMPUTER_USE] = {
    available: true,
    detail: 'Always possible from an agent that has a computer-use runtime; not driven by this server.',
  };

  if (assistantFound) {
    out.recommended = TRANSPORTS.WM_COMMAND;
    out.notes.push('AI-Assistant was detected, but T1 IPC is not implemented. Use menu commands, CAL or MIDI.');
  } else {
    out.recommended = TRANSPORTS.WM_COMMAND;
    out.notes.push(
      'AI-Assistant transport is unavailable, so CakeScript cannot be dispatched from here. '
      + 'Menu commands still work (track transport, open dialogs, toggle views). '
      + 'For project edits use the MIDI/ACT path instead (see README, phase 2).'
    );
  }

  // The command index is a useful cross-check even when unused for posting.
  const idxPath = commandIndexPath();
  if (idxPath) out.notes.push(`Command index: ${idxPath}`);

  capCache = out; capAt = Date.now();
  return out;
}

/**
 * Run a menu command by numeric id through T2. Throws if T2 is not usable.
 */
export async function runCommand(cmdId, opts) {
  // The destructive gate must not depend on the transport being up: the audit
  // found an offset id reaching the transport check first, and cw_verify_commands
  // probing a gated id, because the old check lived after this probe.
  assertCommandAllowed(cmdId, opts && opts.confirm);
  const caps = await capabilities();
  if (!caps.transports[TRANSPORTS.WM_COMMAND].available) {
    const e = new Error('WM_COMMAND transport unavailable: no SONAR menu is readable right now.');
    e.code = 'NO_WM_COMMAND';
    throw e;
  }
  const { runCommand: post } = await import('./menu.js');
  return post(cmdId, opts);
}

/**
 * Explain why a CakeScript-backed tool cannot run, in terms a caller can act on.
 * Returns null when T1 is available (i.e. no error to report).
 *
 * Note what this does NOT say: the engine is present. Disassembly of 2026.10
 * shows sol2 + Lua 5.4 bound to a full object model (CakeScript::ITrack,
 * IClip, IMIDIEventAdv, IAutomation, IArrangement, ITakeLane, …), and the
 * write_cakescript / run_cakescript / get_project_summary tool descriptions are
 * still in the binary. What is missing is an *unattended* way in: the old
 * XCDLLMSERVER IPC window is gone, and the menu entry that replaces it
 * (处理 > 运行 CakeScript 程序, id 42893) opens the membership panel on a free
 * licence. So the honest statement is "gated", not "removed" — the first is
 * lifted by a subscription, the second only by a new build.
 */
export async function cakeScriptBlocker() {
  const caps = await capabilities();
  if (caps.transports[TRANSPORTS.WINDOW_MESSAGE].available) return null;
  if (caps.transports[TRANSPORTS.WINDOW_MESSAGE].detected) {
    const e = new Error('AI-Assistant is detected, but T1 IPC is not implemented. Use menu commands, CAL or MIDI.');
    e.code = 'T1_CHAIN_UNIMPLEMENTED';
    e.detail = caps;
    return e;
  }
  const e = new Error(
    'CakeScript cannot be dispatched from here: no AI-Assistant window in SONAR '
    + `(${caps.sonar.build || 'unknown build'}). `
    + 'The engine itself is present in this build, but the unattended entry point '
    + '(write_cakescript/run_cakescript IPC) is gone, and the menu equivalent '
    + '— 处理 > 运行 CakeScript 程序, command 42893 — is gated behind a paid '
    + 'membership on a free licence. '
    + 'Available alternatives: (1) menu commands via cw_run_command, '
    + '(2) the MIDI/ACT transport for real-time control, '
    + '(3) the editing dialogs, which ARE writable (see cw_quantize_dialog), '
    + '(4) a computer-use agent driving the UI.'
  );
  e.code = 'CAKESCRIPT_UNAVAILABLE';
  e.detail = caps;
  return e;
}

export function invalidateCapabilities() { capCache = null; }
