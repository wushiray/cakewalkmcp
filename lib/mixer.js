// lib/mixer.js — mixer control that actually works on this build.
//
// The measurement first, because it explains the design. On 32.10.0.021 the
// track strips expose a full set of controls through accessibility, and every
// one of them is read-only:
//
//   声像 on Track 1   "0% 中"   AXSetValue -> accepted, unchanged
//   音量 on Track 1   "101"     AXSetValue -> accepted, unchanged
//   手动静音           "关闭"    AXPress    -> accepted, unchanged
//   独奏              "关闭"    AXPress    -> accepted, unchanged
//
// Surveyed across 3 tracks and 15 controls: none changed, and a screenshot
// confirmed the button state was genuinely unchanged rather than a stale value.
// SONAR's accessibility layer reports mixer state for screen readers; it does
// not accept it.
//
// So there are exactly two ways to set a track's volume or pan from outside:
//
//   1. MIDI channel messages (CC 7 volume, CC 10 pan). These reach the engine
//      rather than the UI, so they work — but a channel message only affects a
//      track when that track is listening: armed for recording, or assigned to
//      the channel via ACT. See `targets` below.
//
//   2. A MIDI file. Writing CC7/CC10 into the file a project is imported from
//      is the most reliable route of all, because it needs no live routing:
//      SONAR reads the events as track data when it loads the file.
//
// What this module does NOT do is pretend a UI click worked. If a caller wants
// a fader moved and no armed track is available, the honest answer is that the
// message was delivered but not applied.

import * as live from './live.js';
// One CC table, imported rather than redefined: two tables under two spellings
// is how a pan value silently became a bank select.
import { CC } from '../bridge/midi.js';

/** CC numbers that address mixer parameters, and how they map. */
export const MIXER_CC = {
  volume: CC.VOLUME,        // 7  — channel volume, 0..127
  pan: CC.PAN,              // 10 — 0 = hard left, 64 = centre, 127 = hard right
  expression: CC.EXPRESSION, // 11 — scaled volume, follows volume
  modulation: CC.MODULATION, // 1  — often routed to vibrato or a macro
  reverbSend: 91,
  chorusSend: 93,
};

/**
 * Pan helpers: the value form is 0..127 with 64 at centre.
 *
 * The halves are unequal (64 steps left of centre, 63 right), so each side is
 * scaled by its own span — otherwise -1 lands on 1 instead of 0 and describePan
 * reads "102% left" at hard left. Kept in step with midi-file.js by a test that
 * compares the two.
 */
export const panValue = (normalised) => {
  const v = Math.max(-1, Math.min(1, Number(normalised) || 0));
  return v < 0 ? Math.round(64 + v * 64) : Math.round(64 + v * 63);
};

/** Turn a 0..127 pan value back into a readable position. */
export function describePan(value) {
  const v = Number(value);
  if (v === 64) return 'centre';
  const span = v < 64 ? 64 : 63;
  const pct = Math.round((Math.abs(v - 64) / span) * 100);
  return `${pct}% ${v < 64 ? 'left' : 'right'}`;
}

/** 0..127 CC value to a 0..1 fader position (the convention DAWs display). */
export const volumeValue = (normalised) =>
  Math.round(Math.max(0, Math.min(1, Number(normalised) || 0)) * 127);

/**
 * Describe what a live CC can and cannot affect right now. A channel message
 * needs a listening destination; without one it is delivered to SONAR and
 * dropped, which is invisible unless you check.
 */
export async function mixerTargets() {
  const st = await live.liveStatus();
  return {
    port: st.selected,
    sonarReceives: st.sonarReceives,
    appliesWhen: [
      'a MIDI track is record-armed and its input is the cable (or 全通道)',
      'the track is assigned to the same MIDI channel as the message',
      'or ACT / MIDI-learn is bound so the channel drives the focused control',
    ],
    caveat:
      'An armed flag cannot be set through accessibility on this build (verified: AXPress on 录制 '
      + 'is accepted and does not change the value). Arm it in the UI, or use a MIDI file.',
    note: st.sonarReceives
      ? 'The config enables the cable for SONAR (TTSSEQ.INI), so messages will be accepted when SONAR '
        + 'is running — they still need a destination.'
      : 'SONAR is not configured to receive the cable; run cw_enable_midi_port first.',
  };
}

/**
 * Set a track's pan over the live MIDI cable.
 *
 * `channel` is the MIDI channel the track listens on, not the track's position —
 * these differ, and the track strip reports the real one ("MIDI 通道 on Track N",
 * e.g. "2: <default>" means channel 2).
 *
 * Be precise about what this does. Measured on 32.10.0.021: sending CC10 to a
 * channel whose track is *not* armed does **not** move the strip's pan — read
 * back after a send, the value was unchanged. A channel message affects a track
 * only where the track is monitoring: record-armed, or driven by ACT. And arming
 * cannot be set through automation here (AXPress on 录制 is a no-op), so in
 * practice the reliable way to set volume and pan is a .mid file — see
 * `bakeIntoFile` and cw_write_midi_file.
 */
export async function setPan({ channel = 1, position, value }) {
  const cc = value === undefined ? panValue(position) : Number(value);
  const r = await live.sendCC(channel, MIXER_CC.pan, cc);
  return {
    ...r,
    channel,
    cc: MIXER_CC.pan,
    value: cc,
    describes: describePan(cc),
    applied: 'only where the track is monitoring that channel (armed, or ACT-bound)',
    measured: 'With nothing armed, this does not move the strip value — verified by reading it back.',
    reliableAlternative: 'cw_write_midi_file with panCC, then import. The value is adopted as the '
      + 'track\'s initial pan and survives without any live routing.',
  };
}

/** Set a track's volume over the live cable. `level` is 0..1, or pass `value` 0..127. */
export async function setVolume({ channel = 1, level, value }) {
  const cc = value === undefined ? volumeValue(level) : Number(value);
  const r = await live.sendCC(channel, MIXER_CC.volume, cc);
  return {
    ...r,
    channel,
    cc: MIXER_CC.volume,
    value: cc,
    applied: 'only where the track is monitoring that channel (armed, or ACT-bound)',
    reliableAlternative: 'cw_write_midi_file with volumeCC, then import.',
  };
}

/**
 * Set pan and volume for several channels in one round trip.
 * `mix` is [{ channel, pan?, volume? }] with pan in -1..1 or a raw `panCC`.
 */
export async function applyMix(mix) {
  const messages = [];
  const summary = [];
  for (const entry of mix || []) {
    const ch = Number(entry.channel) || 1;
    if (entry.pan !== undefined || entry.panCC !== undefined) {
      const v = entry.panCC !== undefined ? Number(entry.panCC) : panValue(entry.pan);
      messages.push(live.controlChange(ch, MIXER_CC.pan, v));
      summary.push({ channel: ch, param: 'pan', value: v, describes: describePan(v) });
    }
    if (entry.volume !== undefined || entry.volumeCC !== undefined) {
      const v = entry.volumeCC !== undefined ? Number(entry.volumeCC) : volumeValue(entry.volume);
      messages.push(live.controlChange(ch, MIXER_CC.volume, v));
      summary.push({ channel: ch, param: 'volume', value: v });
    }
  }
  const r = await live.sendMessages(messages);
  return { ok: r.ok, sent: r.sent, applied: summary };
}

// --- static measurement, for the record --------------------------------------

export const MIXER_WRITE_SUPPORT = {
  measuredOn: '32.10.0.021',
  accessibility: {
    readable: true,
    writable: false,
    survey: '3 tracks x 5 controls (声像 / 音量 / 力度+ / 手动静音 / 独奏) = 15 attempted writes; '
      + 'every call accepted, none changed the value; one confirmed against a screenshot.',
  },
  midi: {
    readable: false,
    writable: true,
    requires: 'a listening destination — an armed track, a channel assignment, or ACT',
    latencyMs: '~30 per message',
  },
  midiFile: {
    readable: true,
    writable: true,
    requires: 'nothing live — the events are read when the project loads',
    note: 'CC7 and CC10 written into the file become track data. This is the most reliable route.',
  },
};
