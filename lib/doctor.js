// lib/doctor.js — one command that says which transport paths are still alive.
//
// WHY THIS EXISTS
//
// This adapter's capability rests on five transports, and a SONAR update can
// quietly degrade any of them:
//
//   T1 cakescript   window messages to a Lua engine this build does not have
//   T2 wm-command   menu ids read live from the menu bar
//   T3 surface      a control-surface DLL over a loopback TCP bridge
//   T4 realtime     a loopMIDI cable through winmm
//   T5 uia-click    accessibility locate + real click + read-back
//
// After an upgrade the failure is rarely an error — it is a tool that returns
// "unconfirmed", or a click that no longer lands. Diagnosing that one tool at a
// time cost this project real hours. cw_doctor probes every transport in one
// round and reports a verdict per channel, so the first call after an upgrade
// says exactly what changed.
//
// DESIGN RULES
//
//   * Each probe is independent and exception-proof. One transport failing must
//     not mask the others — an early version threw out of the first probe and
//     reported nothing about the remaining four.
//   * Probes never change project state. Reading is free; anything that writes
//     is checked for readability only, not toggled.
//   * Every verdict carries `whatItMeans` and `fix`, because "T3: fail" without
//     a remedy is a puzzle, not a diagnosis.
//
// VERDICTS
//
//   pass        the path works end to end, measured just now
//   degraded    the path exists but is missing part of its environment (e.g. no
//               project open, so track strips — and T5 — cannot exist)
//   unavailable the path cannot work in this session
//
// `degraded` is not a failure and must not read as one: T5 without a project is
// like a car with no road.

import { hostStatus } from './run.js';
import { capabilities } from './dispatch.js';
import { surfaceStatus } from './surface.js';
import { liveStatus } from './live.js';
import { documentState, visibleTracks, readTrackControl } from './track-ui.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// A probe that never finishes is worse than one that fails: the doctor would
// hang exactly when the user needs a diagnosis. Every probe races a hard
// deadline, and the loser is reported as 'unavailable' with that explanation.
// 20s covers the slowest legitimate probe (T5's UIA enumeration through
// PowerShell on a cold cache); nothing healthy takes longer.
const PROBE_TIMEOUT_MS = 20000;

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${label} probe exceeded ${ms}ms — killed so the rest of the doctor can finish`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function probe(name, fn) {
  try {
    const detail = await withDeadline(Promise.resolve(fn()), PROBE_TIMEOUT_MS, name);
    return { probe: name, ...detail };
  } catch (e) {
    return { probe: name, verdict: 'unavailable', detail: (e.message || String(e)).slice(0, 300) };
  }
}

export async function doctor() {
  const results = await Promise.all([
    probe('host', probeHost),
    probe('t1-cakescript', probeCakeScript),
    probe('t2-wm-command', probeWmCommand),
    probe('t3-surface', probeSurface),
    probe('t4-realtime-midi', probeMidi),
    probe('t5-uia-click', probeUia),
  ]);

  const byName = Object.fromEntries(results.map(r => [r.probe, r]));
  const doc = byName.host.detail && byName.host.detail.document;

  return {
    verdict: overall(results),
    probedAt: new Date().toISOString(),
    channels: results,
    upgradeHints: upgradeHints(results, doc),
  };
}

/** The run is as healthy as its worst load-bearing channel. */
function overall(results) {
  const v = results.map(r => r.verdict);
  if (v.every(x => x === 'pass' || x === 'degraded')) return 'healthy';
  if (v.includes('pass')) return 'partially-healthy';
  return 'unhealthy';
}

async function probeHost() {
  const st = hostStatus();
  const doc = await documentState();
  const running = !!(st && st.sonar_running);
  // The ghost state, seen four times on 2026.10 and always after an external
  // SetForegroundWindow/ShowWindow: the Sonar.exe PROCESS is alive and well
  // (audio engine, MIDI, surface plugin all keep working) but its main FRAME
  // window is destroyed — no 'Sonar'-class window exists, only HUD panes and
  // tooltips. From outside it looks like "SONAR closed without exiting".
  // documentState reading title 'HUDNow' was the old symptom of the same thing.
  // It is named here because restart is the only fix, and a diagnosis that says
  // that in words saves an hour of probing.
  const ghost = running && (!doc || !doc.known ||
    (doc.title && /HUDNow/.test(doc.title)));
  return {
    verdict: running && !ghost ? 'pass' : 'unavailable',
    detail: {
      sonarRunning: running, sonarPath: st && st.sonar_path,
      document: doc, frameGhost: ghost,
    },
    whatItMeans: 'the user32 shim can see the SONAR process AND its main frame window',
    fix: ghost
      ? 'GHOST STATE: the Sonar.exe process is alive but its main window is gone '
        + '(seen after external foreground operations on 2026.10). Restart SONAR — '
        + 'the audio engine still works, but every UI path is dead.'
      : running ? 'nothing'
        : 'start SONAR; if it is running but not seen here, the shim died — restart the MCP server',
  };
}

async function probeCakeScript() {
  return cakescriptChannel(await capabilities());
}

/** Classify a capabilities() result for the T1 channel. Exported for tests. */
export function cakescriptChannel(caps) {
  // dispatch.js publishes the T1 transport under 'window-message'; reading
  // 'cakescript' meant a build that DOES expose the Assistant was still
  // reported unavailable. Keep the old key as a fallback for stored shapes.
  const t1 = caps.transports
    && (caps.transports['window-message'] || caps.transports.cakescript);
  const gone = !t1 || (!t1.detected && t1.available === false);
  return {
    // Not a failure. This build has no dispatchable CakeScript entry point and
    // the adapter was built knowing that; SOME T1 tools fall back by design.
    //
    // The fix text used to claim all of them do ("the affected tools fall back to
    // CAL / T2 / T5"). That was false: mute/solo/arm fall back to a real click and
    // transport falls back to the menu commands, but list_tracks, get_track,
    // set_track_volume, set_track_pan, get_clips, get_notes and locate have no
    // second implementation and simply fail. An external tester hit exactly that
    // gap. Naming both groups is the honest answer.
    verdict: gone ? 'unavailable' : 'degraded',
    detail: { available: false, detected: !gone, implemented: false,
      state: gone ? 'not-detected' : 'detected-not-implemented',
      detail: t1 ? t1.detail : 'transport absent from capabilities' },
    whatItMeans: 'Lua-side track tools (cw_list_tracks, cw_get_clips, …) on builds that ship CakeScript. '
      + 'NOTE: this adapter DETECTS T1 but does not implement its IPC (the bridge has no '
      + 'init/toolcall operation), so no template is dispatched even when the panel exists.',
    fix: gone
      ? 'expected on this build — nothing to do. Some tools fall back (cw_set_track_mute / solo / arm '
        + 'via a real click on the strip, cw_transport via the menu commands, cw_set_track_name via '
        + 'the name field). These do NOT and will report so: cw_list_tracks, cw_get_track, '
        + 'cw_set_track_volume, cw_set_track_pan, cw_get_clips, cw_get_notes, cw_locate — each one '
        + 'names its replacement in its own error.'
      : 'T1 IPC is not implemented in this adapter. Use T2 menu commands, CAL, or MIDI; '
        + 'detecting the Assistant does not enable template dispatch.',
  };
}

async function probeWmCommand() {
  const caps = await capabilities();
  const t2 = caps.transports && caps.transports['wm-command'];
  const ok = t2 && t2.available;
  return {
    verdict: ok ? 'pass' : 'unavailable',
    detail: { available: !!ok, detail: t2 ? t2.detail : null },
    whatItMeans: 'posting menu commands by id (preferences, views, newProject, …)',
    fix: ok ? 'nothing' : 'the menu bar could not be read — is SONAR showing a modal dialog? cw_list_overlays',
  };
}

async function probeSurface() {
  return surfaceChannel(await surfaceStatus());
}

/**
 * Classify a surfaceStatus() result. Exported so the verdict rules can be tested
 * without a SONAR and without the plugin — the rules are where the bugs were.
 */
export function surfaceChannel(st) {
  // Field names measured, not assumed: surfaceStatus reports bridge_reachable
  // (is anything listening on the bridge port) and connected (did the host call
  // Connect). Reading st.ok here was the first version's bug — that field does
  // not exist, so the probe always said "unavailable" and the channel looked
  // broken while it was working.
  const listening = !!(st && st.bridge_reachable);
  // Distinguish "loaded and connected" from "registered but SONAR has not added
  // the surface this session" — the second is the known per-launch cost, and it
  // needs different words than a real failure.
  const connected = listening && st.connected;
  return {
    verdict: connected ? 'pass' : (listening ? 'degraded' : 'unavailable'),
    detail: st,
    whatItMeans: 'the OPTIONAL control-surface bridge (diagnostics only — no capability depends on it)',
    // The fix text used to tell the reader to install and add the surface, which
    // now contradicts the project: the surface is opt-in, install.ps1 skips it by
    // default, and every capability it once carried has a file/click/CAL path
    // that does not need it. Telling someone to install a component the installer
    // deliberately skips is how a healthy machine gets reported as broken.
    fix: connected
      ? 'nothing — enabled by choice, working'
      : st && st.state === 'not-configured'
        ? 'optional diagnostics are not configured; no capability needs them. Leave disabled '
          + 'for normal use. Deliberate diagnostic sessions require the same CW_SURFACE_TOKEN '
          + 'in SONAR and MCP; no connection was attempted.'
      : listening
        ? 'DLL loaded but Connect() has not fired. The surface is only instantiated when '
          + 'it is added in 参数设置 > MIDI > 控制界面, and SONAR never restores it at '
          + 'startup — that manual step is exactly why it is opt-in and unnecessary.'
        : (st && st.state === 'not-installed'
            ? 'not installed — this is the DEFAULT and no capability needs it. Install it '
              + 'only for diagnostics/experiments with: deploy\\install.ps1 -WithSurface'
            : 'the surface was not added this session. Not a fault: it is opt-in and nothing '
              + 'depends on it. Add it in 参数设置 > MIDI > 控制界面 only if you want the '
              + 'surface diagnostics.'),
  };
}

async function probeMidi() {
  return midiChannel(await liveStatus());
}

/**
 * Classify a liveStatus() result.
 *
 * Three states, not two. The old version asked only `available` — "can a MIDI
 * OUT port be opened" — and answered pass / fix: nothing on that basis. A send
 * succeeds at the driver level whether or not anything is listening, so a SONAR
 * with no matching MIDI INPUT enabled produced a channel reported as perfectly
 * healthy while it dropped every note and every CC.
 *
 * Exported for tests: these three branches are the whole fix, and they used to
 * have no coverage at all.
 */
export function midiChannel(st) {
  // Three states, not two. The old version asked only `available` — "can a MIDI
  // OUT port be opened" — and answered pass / fix: nothing on that basis. But a
  // send succeeds at the driver level whether or not anything is listening, so a
  // SONAR with no matching MIDI INPUT enabled produced a channel reported as
  // perfectly healthy while it dropped every note and every CC. An external
  // tester hit exactly this and called it "pass, but there is a catch" — the
  // catch is the entire purpose of the channel.
  //
  // `sonarReceives` is read from SONAR's own TTSSEQ.INI, which is the only way
  // to verify the receive side without driving a UI.
  const canSend = !!(st && st.available && st.selected);
  const heard = !!(st && st.sonarReceives);
  return {
    verdict: canSend ? (heard ? 'pass' : 'degraded') : 'unavailable',
    detail: st,
    whatItMeans: 'the loopMIDI cable: notes, chords, CC7/CC10 volume and pan',
    fix: !canSend
      ? 'no usable MIDI out port — is loopMIDI running? cw_midi_status lists the devices'
      : heard
        // Enabled is not the same as routed: even here a message needs somewhere
        // to land, and arming cannot be set through automation on this build.
        ? 'nothing — SONAR has the port enabled. Messages still need a destination: arm a '
          + 'MIDI track, assign the port as that track\'s input, or bind it through ACT.'
        : (st.setup || 'SONAR does not have the selected port enabled as a MIDI input, so '
           + 'sends are accepted by the driver and then discarded.'),
  };
}

async function probeUia() {
  // Three preconditions, checked separately so the verdict names which one broke:
  //   1. the helper script exists          (packaging problem)
  //   2. SONAR is running                  (host problem)
  //   3. a project is open with tracks     (session state, not a defect)
  const script = join(HERE, '..', 'native', 'uia', 'cw_uia.ps1');
  if (!existsSync(script)) {
    return {
      verdict: 'unavailable',
      detail: { script, exists: false },
      whatItMeans: 'locate + real click + read-back on the track strips',
      fix: `the helper is missing at ${script} — reinstall`,
    };
  }
  const doc = await documentState();
  if (!doc.known || !doc.projectOpen) {
    return {
      verdict: 'degraded',
      detail: { script: true, document: doc },
      whatItMeans: 'locate + real click + read-back on the track strips',
      fix: 'open a project — the track strips (and this whole channel) do not exist without one',
    };
  }
  // The only probe here that touches a live control — and it is a pure read.
  const tracks = await visibleTracks();
  if (!tracks.length) {
    return {
      verdict: 'degraded',
      detail: { script: true, document: doc, visibleTracks: [] },
      whatItMeans: 'locate + real click + read-back on the track strips',
      // Two different states produce an empty list, and the old message named
      // only the first: "the project has no tracks — add one or scroll". Measured
      // on a fresh install with a track plainly visible in the Track view, that
      // message sent the reader looking for a missing track when the real cause
      // was that SONAR exposed no <label> on Track N elements at all. State both.
      fix: 'no track strips are visible through accessibility. Either the project has no '
        + 'tracks, or this SONAR build/session does not expose the per-control names — '
        + 'measured on a clean install: the tree held the view containers and the track name '
        + 'but none of the 音量/声像/手动静音 elements. That blocks cw_set_track_mute / solo / '
        + 'arm and cw_set_track_name. Check with: powershell -File native\\uia\\cw_uia.ps1 -Action dump',
    };
  }
  const read = await readTrackControl('mute', tracks[0]);
  const ok = read && read.value != null && read.click[0] != null;
  // A minimized SONAR reports element coordinates around -21000 (the
  // minimized-window coordinate space, measured at -21132 for a strip whose
  // window rect was -21333). Reads still work there; clicks cannot, because
  // SetCursorPos cannot reach the minimized window's screen position. Naming
  // this state beats a mysterious 'verified: false' on every write.
  const minimized = ok && read.click[1] < -20000;
  return {
    verdict: ok && !minimized ? 'pass' : 'degraded',
    detail: { script: true, visibleTracks: tracks, sampleRead: read, sonarMinimized: minimized },
    whatItMeans: 'locate + real click + read-back on the track strips',
    fix: minimized
      ? 'SONAR is MINIMIZED — reads still work but no click can land. Restore the window to write.'
      : ok ? 'nothing'
           : 'controls were found but a read came back without geometry — see native/uia/README.md',
  };
}

/** Per-channel notes worth surfacing after an upgrade specifically. */
export function upgradeHints(results, doc) {
  const hints = [];
  const byName = Object.fromEntries(results.map(r => [r.probe, r]));
  if (byName['t5-uia-click'] && byName['t5-uia-click'].verdict !== 'pass') {
    // Gated on tracks actually having been found. Label drift can only be the
    // cause once the strips exist; when the real reason is "no project open" the
    // hint sends the reader off to edit label lists that are perfectly fine, and
    // it flatly contradicts this channel's own `fix` field in the same reply. An
    // external tester hit exactly that contradiction and reported the fix field
    // as wrong advice.
    const d = byName['t5-uia-click'].detail || {};
    const tracksFound = Array.isArray(d.visibleTracks) && d.visibleTracks.length > 0;
    if (tracksFound) {
      hints.push('T5 degraded usually means label text changed in this SONAR version. '
        + 'The labels live in WRITABLE_CONTROLS (lib/track-ui.js) and the state words '
        + '打开/关闭 in native/uia/cw_uia.ps1 — update those two places only.');
    }
  }
  if (byName['t2-wm-command'] && byName['t2-wm-command'].verdict !== 'pass') {
    hints.push('T2 down is usually a modal dialog holding the menu bar. cw_list_overlays, '
      + 'cw_close_overlays, then cw_verify_commands to re-measure ids.');
  }
  if (byName['t3-surface'] && byName['t3-surface'].verdict === 'degraded') {
    hints.push('The surface is opt-in and no capability needs it. This channel only reaches '
      + '"pass" while it has been added in 参数设置 > MIDI > 控制界面 for the current '
      + 'session, because SONAR does not restore surfaces at startup. Ignore unless you '
      + 'deliberately enabled it for diagnostics.');
  }
  return hints;
}
