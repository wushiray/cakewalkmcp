// lib/live.js — the real-time MIDI transport.
//
// This is the transport that still changes a project on SONAR builds with no
// CakeScript entry point. A loopMIDI cable ("Studio One AI Notes" on this
// machine) is a real Windows MIDI device: we open its OUT port and SONAR reads
// its IN port. Nothing about the path depends on SONAR's scripting engine, and
// latency is the MIDI driver's, not a round trip through PowerShell.
//
// One-time setup, which only the user can do because it lives in SONAR's UI:
//   Preferences (编辑 > 参数设置) > MIDI > Inputs > tick the cable's input
//   port. Then arm a track (or use the ACT/MIDI-learn path) and it receives.
//
// Port preference order: the name the user already configured for this purpose,
// then any loopMIDI-style name, then whatever the caller names explicitly.

import {
  listDevices, openPort, closePort, send, sendAll, panic,
  noteOn, noteOff, controlChange, pitchBend, CC, CH,
} from '../bridge/midi.js';
import { midiConfigSummary } from './midi-config.js';

export const PREFERRED_PORTS = [
  'Studio One AI Notes',
  'loopMIDI',
  'Cakewalk',
];

let opened = null;

/** Every MIDI device Windows reports, in and out. */
export async function devices() {
  const r = await listDevices();
  return r.devices || [];
}

/** Pick the port to use, honouring an explicit name first. */
export async function pickPort(explicit) {
  const all = await devices();
  const outs = all.filter((d) => d.dir === 'out');
  if (explicit) {
    const hit = outs.find((d) => d.name.toLowerCase().includes(String(explicit).toLowerCase()));
    return hit || null;
  }
  for (const want of PREFERRED_PORTS) {
    const hit = outs.find((d) => d.name.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

/** Ensure the preferred port is open; returns { ok, port } or { ok:false, error }. */
export async function ensurePort(explicit) {
  if (opened && !explicit) return { ok: true, port: opened, reused: true };
  const port = await pickPort(explicit);
  if (!port) {
    return {
      ok: false,
      error: explicit
        ? `No MIDI output port matching '${explicit}'.`
        : 'No loopMIDI-style output port found. Install/start loopMIDI and create a port, '
          + 'or pass an explicit port name.',
      available: (await devices()).filter((d) => d.dir === 'out').map((d) => d.name),
    };
  }
  const r = await openPort(port.name);
  if (!r.ok) return { ok: false, error: r.error, port: port.name };
  opened = port.name;
  return { ok: true, port: port.name, index: port.index };
}

export async function releasePort() {
  opened = null;
  return closePort();
}

/**
 * Report the state of the live transport without opening anything: which ports
 * exist, which one we would use, whether SONAR is configured to receive it, and
 * the one-time step the user still owns.
 */
export async function liveStatus() {
  let all = [];
  let error = null;
  try { all = await devices(); } catch (e) { error = e.message; }
  const outs = all.filter((d) => d.dir === 'out');
  const ins = all.filter((d) => d.dir === 'in');
  const port = await pickPort();

  // SONAR's own view, read from TTSSEQ.INI. This is the only way to *verify* the
  // receive side without a UI — a send always "succeeds" at the driver level
  // whether or not anything is listening.
  let cfg = null;
  try { cfg = midiConfigSummary(); } catch (e) { error = `${error || ''} config: ${e.message}`.trim(); }
  const enabledBySonar = !!(cfg && port && cfg.input.some(
    (n) => n.toLowerCase() === port.name.toLowerCase()));

  const result = {
    available: outs.length > 0,
    ports: { out: outs.map((d) => d.name), in: ins.map((d) => d.name) },
    selected: port ? port.name : null,
    open: opened,
    sonarReceives: enabledBySonar,
    sonarConfig: cfg,
    error,
  };

  if (!port) {
    result.setup = 'No loopMIDI output port available. Start loopMIDI and create a port.';
  } else if (enabledBySonar) {
    result.setup = `Ready: SONAR has "${port.name}" enabled as a MIDI input. `
      + 'Arm a MIDI track (or assign the input to ACT / MIDI learn) so incoming messages have a destination.';
  } else {
    result.setup = `SONAR does not have "${port.name}" enabled as a MIDI input. `
      + `Enable it with cw_enable_midi_port (writes ${cfg ? cfg.path : 'TTSSEQ.INI'}), `
      + 'or in SONAR: 编辑 > 参数设置 > MIDI > 设备, tick it in the 输入 list. '
      + 'SONAR picks the change up at startup or when that dialog is applied.';
  }
  return result;
}


/**
 * A send that FAILED must not look like one that worked.
 *
 * midiOutShortMsg returns 0 on success; the bridge now reports that per call.
 * The old code awaited the promise and returned ok:true regardless, so a closed
 * port or a driver rejection was indistinguishable from a delivered message.
 */
export function assertMidiSent(result, what) {
  if (result && result.ok === true) return result;
  const why = (result && (result.error || (result.rc !== undefined && `rc=${result.rc}`))) || 'no result';
  const e = new Error(`${what} was not delivered: ${why}`);
  e.code = 'MIDI_SEND_FAILED';
  e.detail = result;
  throw e;
}

/**
 * Run a send with a self-healing port cache. A failed send (returned ok:false
 * or a rejected promise) means the cached `opened` handle is suspect: the
 * loopMIDI cable may have been disabled and re-enabled. Drop the cache
 * synchronously so the NEXT caller operation re-enumerates and re-opens the
 * port, then best-effort release it. The original result/exception is always
 * preserved even if cleanup fails; we never retry or replay the send here.
 */
async function withPortRecovery(promise) {
  let result;
  try {
    result = await promise;
  } catch (err) {
    opened = null;
    try { await releasePort(); } catch (_) { /* cleanup is best effort */ }
    throw err;
  }
  if (!(result && result.ok === true)) {
    opened = null;
    try { await releasePort(); } catch (_) { /* cleanup is best effort */ }
  }
  return result;
}

// --- musical operations -----------------------------------------------------
// These take 1-based channels, matching how the CakeScript tools number things.

export async function playNote({ channel = 1, pitch, velocity = 100, durationMs = 250 }) {
  const r = await ensurePort();
  if (!r.ok) return r;
  assertMidiSent(await withPortRecovery(send(noteOn(channel, pitch, velocity))), 'note-on');
  await new Promise((res) => setTimeout(res, durationMs));
  assertMidiSent(await withPortRecovery(send(noteOff(channel, pitch))), 'note-off');
  return { ok: true, channel, pitch, velocity, durationMs };
}

/** Play several notes at once, all released together. */
export async function playChord({ channel = 1, pitches, velocity = 100, durationMs = 500 }) {
  const r = await ensurePort();
  if (!r.ok) return r;
  assertMidiSent(await withPortRecovery(sendAll(pitches.map((p) => noteOn(channel, p, velocity)))), 'chord note-on');
  await new Promise((res) => setTimeout(res, durationMs));
  assertMidiSent(await withPortRecovery(sendAll(pitches.map((p) => noteOff(channel, p)))), 'chord note-off');
  return { ok: true, channel, pitches, velocity, durationMs };
}

/**
 * Send a batch of raw messages in one round trip. `messages` is an array of
 * [status, data1, data2]. Use this to lay down a phrase: build it with the
 * note-on / note-off / cc helpers and only pay one bridge hop.
 */
export async function sendMessages(messages, { channel } = {}) {
  const r = await ensurePort();
  if (!r.ok) return r;
  const ch = channel ? CH(channel) : null;
  const normalised = messages.map((m) => {
    const [s, d1 = 0, d2 = 0] = m;
    return ch === null ? [s, d1, d2] : [(s & 0xf0) | ch, d1, d2];
  });
  const res = await withPortRecovery(sendAll(normalised));
  return {
    ok: res.ok,
    sent: res.sent,
    attempted: normalised.length,
    failed: res.failed || 0,
    ...(res.ok ? {} : { error: res.error, rc: res.rc }),
  };
}

/** Channel volume, the usual stand-in for a track fader over MIDI. */
export async function setChannelVolume(channel, value0to127) {
  const r = await ensurePort();
  if (!r.ok) return r;
  assertMidiSent(await withPortRecovery(send(controlChange(channel, CC.VOLUME, value0to127))), 'volume CC');
  return { ok: true, channel, cc: 'volume', value: value0to127 };
}

export async function setChannelPan(channel, value0to127) {
  const r = await ensurePort();
  if (!r.ok) return r;
  assertMidiSent(await withPortRecovery(send(controlChange(channel, CC.PAN, value0to127))), 'pan CC');
  return { ok: true, channel, cc: 'pan', value: value0to127 };
}

export async function sendCC(channel, controller, value) {
  const r = await ensurePort();
  if (!r.ok) return r;
  assertMidiSent(await withPortRecovery(send(controlChange(channel, controller, value))), 'control change');
  return { ok: true, channel, controller, value };
}

export async function bend(channel, value14) {
  const r = await ensurePort();
  if (!r.ok) return r;
  assertMidiSent(await withPortRecovery(send(pitchBend(channel, value14))), 'pitch bend');
  return { ok: true, channel, value: value14 };
}

/**
 * All notes off on every channel we might have touched, plus a driver reset.
 *
 * Silence is a safety operation, so it must never claim a success it did not
 * have. Every failure below is reported or thrown instead of being swallowed:
 *   1. no port            -> the ensurePort result { ok:false, error } is returned
 *                            unchanged (no sends are attempted);
 *   2. a rejected batch   -> withPortRecovery clears the cached handle and the
 *                            exception propagates (assertMidiSent is not reached
 *                            because there is no result to inspect);
 *   3. failed CCs         -> assertMidiSent throws MIDI_SEND_FAILED, and the
 *                            driver reset is deliberately NOT attempted on a
 *                            suspect/closed port;
 *   4. failed reset       -> panic() says so ('panic was not delivered: ...'),
 *                            rc included in the message.
 * Only a fully delivered 32-CC batch followed by a successful midiOutReset
 * returns ok:true. No retries: a retry would turn a failure into a "success".
 */
export async function allNotesOff() {
  const r = await ensurePort();
  if (!r.ok) return r;
  const messages = [];
  for (let ch = 1; ch <= 16; ch++) {
    messages.push(controlChange(ch, CC.ALL_NOTES_OFF, 0));
    messages.push(controlChange(ch, CC.RESET_ALL_CONTROLLERS, 0));
  }
  const sent = assertMidiSent(
    await withPortRecovery(sendAll(messages)),
    'all-notes-off (all sound / controllers)',
  );
  const reset = assertMidiSent(await withPortRecovery(panic()), 'panic (midiOutReset)');
  return {
    ok: true,
    sent: sent.sent,
    attempted: sent.attempted === undefined ? messages.length : sent.attempted,
    reset: reset.rc === undefined ? 0 : reset.rc,
  };
}

export { noteOn, noteOff, controlChange, pitchBend, CC };
