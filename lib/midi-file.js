// lib/midi-file.js — read and write Standard MIDI Files.
//
// Why this is part of a SONAR adapter: SONAR's accessibility layer exposes the
// track-control level (volume, pan, mute, solo, routing, patch) but nothing at
// the data level. There is no note, clip or event element anywhere in the tree —
// verified across a live project. On a build with no CakeScript transport, a
// .mid file is therefore the only way to move notes in or out:
//
//   * write  — generate a file, import it (0xE101 opens an MFC dialog whose
//              filename field does accept AXSetValue, so this is fully scriptable)
//   * read   — parse a file SONAR exported, or one already on disk
//
// CC7 and CC10 in the file become track volume and pan on import — verified
// end to end: a bass track written with CC10=30 came back reading "53% 左", and
// a pad written with CC10=98 read "54% 右".
//
// Format 1 (several tracks, one shared tempo map) is what a multi-part
// arrangement wants, so that is what write() emits.

import { readFileSync, statSync, writeFileSync } from 'node:fs';

export const PPQ = 480;
export const BEAT = PPQ;
export const BAR = PPQ * 4;

// --- writing -----------------------------------------------------------------

/** MIDI status helpers. Channel is 0-based in the raw byte. */
export const on = (ch, pitch, vel) => [0x90 | (ch & 0x0f), pitch & 0x7f, vel & 0x7f];
export const off = (ch, pitch) => [0x80 | (ch & 0x0f), pitch & 0x7f, 0];
export const cc = (ch, controller, value) => {
  // Guard the same way bridge/midi.js does: an undefined controller would pass
  // the mask as CC0 and read as a bank select rather than an error.
  if (!Number.isFinite(Number(controller))) {
    throw new TypeError(`cc: controller must be a number, got ${controller}`);
  }
  return [0xb0 | (ch & 0x0f), Number(controller) & 0x7f, value & 0x7f];
};
export const pc = (ch, program) => [0xc0 | (ch & 0x0f), program & 0x7f];

/**
 * Controller numbers, matching bridge/midi.js under both spellings so a value
 * from either module works in the other. See the note there for why the casing
 * matters — it is the difference between CC10 and CC0.
 */
export const CC = {
  bankSelect: 0, BANK_SELECT_MSB: 0,
  modulation: 1, MODULATION: 1,
  breath: 2, BREATH: 2,
  volume: 7, VOLUME: 7,
  pan: 10, PAN: 10,
  expression: 11, EXPRESSION: 11,
  sustain: 64, SUSTAIN: 64,
  reverb: 91, REVERB: 91,
  chorus: 93, CHORUS: 93,
  allSoundOff: 120, ALL_SOUND_OFF: 120,
  resetAllControllers: 121, RESET_ALL_CONTROLLERS: 121,
  allNotesOff: 123, ALL_NOTES_OFF: 123,
};

/**
 * MIDI convention: 64 is centre, 0 hard left, 127 hard right.
 *
 * The two halves are not the same width — centre to hard right is 63 steps,
 * centre to hard left is 64 — so a single multiplier cannot be symmetric. Scale
 * each side by its own span, which makes -1 land exactly on 0 and +1 exactly on
 * 127. (Using 63 for both put -1 at 1, and made describePan report "102% left"
 * for hard left.)
 */
export const panCC = (normalised) => {
  const n = Math.max(-1, Math.min(1, Number(normalised) || 0));
  return n < 0 ? Math.round(64 + n * 64) : Math.round(64 + n * 63);
};

/** Turn a 0..127 pan value into words, matching how SONAR displays it. */
export function describePan(v) {
  const n = Number(v);
  if (n === 64) return 'centre';
  // Each half is measured against its own span, so hard left reads 100% not 102%.
  const span = n < 64 ? 64 : 63;
  return `${Math.round((Math.abs(n - 64) / span) * 100)}% ${n < 64 ? 'left' : 'right'}`;
}

// A delta time is a 28-bit quantity in the SMF spec (four bytes max). The old
// implementation used `n >>= 7`, which coerces to signed 32-bit: a tick of 2**31
// became a negative shift and silently wrote `00`, so a note landed at the start
// of the file with duration 0. Reject anything the format cannot represent
// instead of corrupting it.
export const MAX_TICK = 0x0fffffff;

function assertTick(n, what = 'tick') {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_TICK) {
    throw new RangeError(`${what} must be an integer in 0..${MAX_TICK}, got ${n}`);
  }
}

// Append an array without spreading it into the argument list: `push(...bytes)`
// throws RangeError (stack overflow) once an event's payload is large, and a
// meta or sysex event may legally be megabytes long. This was the last path to
// the P3 stack-overflow report after the track-name cap.
function pushBytes(target, arr) {
  for (let i = 0; i < arr.length; i++) target.push(arr[i]);
}

function vlq(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_TICK) {
    throw new RangeError(`delta time must be an integer in 0..${MAX_TICK}, got ${n}`);
  }
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  return bytes;
}


/**
 * Check a caller-supplied event's byte structure.
 *
 * The schema only requires a non-empty array, so `bytes: [0x90]` (a note-on
 * with no pitch or velocity) used to be written out as a 55-byte "successful"
 * file that SONAR cannot interpret. Validate by status: channel messages need
 * their data bytes (and 7-bit values), meta needs a well-formed length, sysex
 * too, and a system-common message has a fixed size.
 */
function assertEventBytes(bytes, tick) {
  if (!Array.isArray(bytes) || bytes.length === 0) {
    throw new TypeError(`event at tick ${tick} has no bytes`);
  }
  const st = bytes[0];
  for (const b of bytes) {
    if (!Number.isInteger(b) || b < 0 || b > 255) {
      throw new RangeError(`event at tick ${tick} has a byte outside 0..255: ${b}`);
    }
  }
  if (st === 0xff) {
    if (bytes.length < 3) throw new RangeError(`meta event at tick ${tick} needs type and length bytes`);
    const meta = bytes[1];
    // A meta type is a 7-bit number. `ff 90 ...` is not "a meta event with type
    // 0x10 that happens to look odd" — the high bit means the byte is not a
    // type at all, and a reader that masks it would parse the event differently.
    if (meta > 0x7f) {
      throw new RangeError(`meta event at tick ${tick} has a type byte of 0x${meta.toString(16)}; `
        + 'a meta type must be <= 0x7f');
    }
    // The length must be a COMPLETE variable-length quantity. `[ff, 01, 80]` used
    // to be accepted as "length 0 with one trailing byte" because the mask
    // dropped the continuation bit, so a truncated length read as a finished one
    // and the payload was taken from whatever followed.
    let len = 0;
    let k = 2;
    let terminated = false;
    for (let n = 0; n < 4 && k < bytes.length; n++) {
      const b = bytes[k++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) { terminated = true; break; }
    }
    if (!terminated) {
      throw new RangeError(`meta event at tick ${tick} has a truncated length `
        + '(no VLQ byte without the continuation bit)');
    }
    if (bytes.length !== k + len) {
      throw new RangeError(`meta event at tick ${tick} declares ${len} payload bytes but carries `
        + `${Math.max(0, bytes.length - k)}`);
    }
    // End of track carries no payload. A non-empty one makes readers stop at a
    // different place from the writer, and buildTrack() appends its own EOT, so
    // a caller's would either be dropped or truncate the track.
    if (meta === 0x2f && len !== 0) {
      throw new RangeError(`end-of-track meta at tick ${tick} must have a zero length, got ${len}`);
    }
    return;
  }
  if (st === 0xf0 || st === 0xf7) {
    if (bytes.length < 2) throw new RangeError(`sysex event at tick ${tick} has no length byte`);
    let len = 0;
    let k = 1;
    let terminated = false;
    for (let n = 0; n < 4 && k < bytes.length; n++) {
      const b = bytes[k++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) { terminated = true; break; }
    }
    if (!terminated) {
      throw new RangeError(`sysex event at tick ${tick} has a truncated length `
        + '(no VLQ byte without the continuation bit)');
    }
    if (bytes.length !== k + len) {
      throw new RangeError(`sysex event at tick ${tick} declares ${len} bytes but carries `
        + `${Math.max(0, bytes.length - k)}`);
    }
    return;
  }
  if (st >= 0xf1 && st <= 0xfe) {
    const need = (st === 0xf1 || st === 0xf3) ? 2 : (st === 0xf2) ? 3 : 1;
    if (bytes.length !== need) {
      throw new RangeError(`system message 0x${st.toString(16)} at tick ${tick} needs `
        + `${need - 1} data byte(s), got ${bytes.length - 1}`);
    }
    // These are data bytes too: a byte above 127 in a system-common message is
    // corrupt, not "large".
    for (let k = 1; k < bytes.length; k++) {
      if (bytes[k] > 0x7f) {
        throw new RangeError(`data byte ${bytes[k]} of system message 0x${st.toString(16)} `
          + `at tick ${tick} exceeds 127`);
      }
    }
    return;
  }
  const type = st & 0xf0;
  if (type < 0x80 || type > 0xe0) {
    throw new RangeError(`event at tick ${tick} does not start with a status byte: 0x${st.toString(16)}`);
  }
  const dataCount = (type === 0xc0 || type === 0xd0) ? 1 : 2;
  if (bytes.length !== 1 + dataCount) {
    throw new RangeError(`channel message 0x${st.toString(16)} at tick ${tick} needs ${dataCount} `
      + `data byte(s), got ${bytes.length - 1}`);
  }
  for (let k = 1; k < bytes.length; k++) {
    if (bytes[k] > 0x7f) {
      throw new RangeError(`data byte ${bytes[k]} at tick ${tick} exceeds 127`);
    }
  }
}

/**
 * Build a track chunk.
 *
 * `events` is [{ tick, bytes }]. If `mix` is given it is emitted first, at tick
 * 0 — the position that makes SONAR adopt the values as the track's initial
 * volume and pan rather than an automation curve partway in.
 *
 * `channel` is 1-based here and converted internally, matching the rest of this
 * adapter and every UI that shows a channel number. (It used to be 0-based while
 * `write()`'s output added 1 back, which made it easy to build a file whose
 * program change and CC landed one channel above its notes — silent, and only
 * visible as a mix on the wrong strip after import.)
 */
export function buildTrack(events = [], { channel = 1, program, name, mix } = {}) {
  const chNum = Number(channel);
  if (!Number.isInteger(chNum) || chNum < 1 || chNum > 16) {
    // 0 and 17 used to become channel 1 and 15 through `(n || 1) - 1` and a
    // 4-bit mask. Silent, and only visible as notes on the wrong instrument.
    throw new RangeError(`channel must be an integer 1..16, got ${channel}`);
  }
  const ch = chNum - 1;
  const data = [];
  if (name !== undefined) {
    const nb = Buffer.from(String(name), 'utf8');
    // A 150k-character name used to blow the stack through `push(...nb)`.
    if (nb.length > 1024) {
      throw new RangeError(`track name is ${nb.length} bytes; the limit is 1024`);
    }
    pushBytes(data, vlq(0));
    data.push(0xff, 0x03);
    pushBytes(data, vlq(nb.length));
    pushBytes(data, nb);
  }
  if (program !== undefined) { pushBytes(data, vlq(0)); pushBytes(data, pc(ch, program)); }
  if (mix) {
    if (mix.volume !== undefined) { pushBytes(data, vlq(0)); pushBytes(data, cc(ch, CC.volume, mix.volume)); }
    if (mix.pan !== undefined) { pushBytes(data, vlq(0)); pushBytes(data, cc(ch, CC.pan, mix.pan)); }
  }
  // Validate before sorting: a NaN or fractional tick used to be coerced to 0
  // by Math.max(0, ...), which moved the event to the file start without a word.
  for (const e of events) {
    assertTick(e.tick);
    // End of track is generated below. Accepting a caller's EOT and also
    // appending our own put an early EOT in the middle of the track, and every
    // reader stops there — so the notes after it were written and then lost.
    // Refusing is loud; silently dropping the caller's EOT is not.
    if (Array.isArray(e.bytes) && e.bytes[0] === 0xff && e.bytes[1] === 0x2f) {
      throw new RangeError(`event at tick ${e.tick} is an end-of-track meta event; `
        + 'buildTrack() adds one itself and anything after an explicit EOT would be lost');
    }
    assertEventBytes(e.bytes, e.tick);
  }
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  let last = 0;
  for (const e of sorted) {
    pushBytes(data, vlq(e.tick - last));
    pushBytes(data, e.bytes);
    last = e.tick;
  }
  pushBytes(data, vlq(0));
  data.push(0xff, 0x2f, 0x00);

  const body = Buffer.from(data);
  const header = Buffer.alloc(8);
  header.write('MTrk', 0, 'ascii');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** A conductor track holding tempo and time signature. */
export function buildConductor({ bpm = 120, timeSig = [4, 4] } = {}) {
  const usPerQuarter = Math.round(60_000_000 / bpm);
  const data = [];
  pushBytes(data, vlq(0));
  data.push(0xff, 0x51, 0x03,
    (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  pushBytes(data, vlq(0));
  data.push(0xff, 0x58, 0x04, timeSig[0], Math.round(Math.log2(timeSig[1])), 0x18, 0x08);
  pushBytes(data, vlq(0));
  data.push(0xff, 0x2f, 0x00);
  const body = Buffer.from(data);
  const header = Buffer.alloc(8);
  header.write('MTrk', 0, 'ascii');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * Assemble and write a format-1 file.
 * `tracks` is [{ events, channel, program, name, mix }], channel 1-based.
 *
 * Consistency check: a track's events should all carry the channel the track
 * declares, because that is the channel SONAR routes CC7/CC10 by. If a caller
 * builds notes on one channel and a mix on another, the file imports with the
 * volume and pan on the wrong strip — silent, and expensive to debug. We catch
 * it here instead.
 */
export function write(path, { bpm = 120, timeSig = [4, 4], tracks = [], overwrite = true } = {}) {
  const warnings = [];
  tracks.forEach((t, i) => {
    if (!Array.isArray(t.events) || t.events.length === 0) {
      // A misspelled field ("note" for "notes") is stripped by zod, leaving an
      // empty track that imports as silence. Say so rather than writing it out
      // as if it were intentional.
      warnings.push(`track ${i}${t.name ? ` (${t.name})` : ''} has no events and will import empty`);
    }
    const declared = ((Number(t.channel) || 1) - 1) & 0x0f;
    const used = new Set();
    for (const e of t.events || []) {
      const b = e.bytes && e.bytes[0];
      if (typeof b === 'number' && b >= 0x80 && b < 0xf0) used.add(b & 0x0f);
    }
    const stray = [...used].filter((c) => c !== declared);
    if (stray.length) {
      warnings.push(
        `track ${i}${t.name ? ` (${t.name})` : ''}: events use channel(s) `
        + `${[...used].map((c) => c + 1).join(', ')} but the track is declared as channel `
        + `${declared + 1}; SONAR routes CC7/CC10 by the declared channel, so they will land on `
        + 'the wrong track.'
      );
    }
  });

  const chunks = [buildConductor({ bpm, timeSig }), ...tracks.map((t) => buildTrack(t.events, t))];
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8);
  header.writeUInt16BE(chunks.length, 10);
  header.writeUInt16BE(PPQ, 12);
  const buf = Buffer.concat([header, ...chunks]);
  try {
    writeFileSync(path, buf, { flag: overwrite === false ? 'wx' : 'w' });
  } catch (err) {
    if (overwrite === false && err && err.code === 'EEXIST') {
      const error = new Error(
        `Refusing to overwrite existing MIDI file: ${path} (pass overwrite: true to replace it)`,
      );
      error.code = 'FILE_EXISTS';
      error.path = path;
      throw error;
    }
    throw err;
  }
  return {
    path,
    bytes: buf.length,
    tracks: chunks.length,
    bpm,
    timeSig,
    warnings: warnings.length ? warnings : undefined,
    describe: tracks.map((t) => ({
      name: t.name,
      channel: Number(t.channel) || 1,
      program: t.program,
      mix: t.mix ? {
        volume: t.mix.volume,
        pan: t.mix.pan,
        panDescribes: t.mix.pan !== undefined ? describePan(t.mix.pan) : undefined,
      } : undefined,
      events: t.events.length,
    })),
  };
}

// --- reading -----------------------------------------------------------------

/**
 * Parse a Standard MIDI File into per-track event lists.
 *
 * Deliberately tolerant: real files carry running status, meta events and
 * sysex, so anything unrecognised is skipped rather than throwing. Returns
 *   { format, division, tracks: [{ name, channelOf, notes, ccs }] }
 * where notes are { tick, pitch, velocity, duration } and ccs are
 * { tick, controller, value }.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function read(path) {
  // The whole file is loaded before the magic check, so a path pointed at a
  // multi-GB file (a disc image, a VM disk) was a memory DoS. Refuse early.
  const st = statSync(path);
  if (st.size > MAX_FILE_BYTES) {
    const e = new Error(`refusing to read ${path}: ${st.size} bytes exceeds the ${MAX_FILE_BYTES}-byte limit`);
    e.code = 'FILE_TOO_LARGE';
    throw e;
  }
  const buf = readFileSync(path);
  if (buf.slice(0, 4).toString('ascii') !== 'MThd') {
    const e = new Error('not a Standard MIDI File (no MThd)');
    e.code = 'NOT_MIDI';
    throw e;
  }
  // The header is MThd + a 4-byte length + that many bytes. The old code read
  // fields at fixed offsets with no length check, so a 4-byte file threw a bare
  // RangeError and a header that declared 8 bytes had its extra 2 bytes read as
  // the first chunk. Honour the declared length instead.
  if (buf.length < 14) {
    const e = new Error(`truncated MIDI header: ${buf.length} bytes`);
    e.code = 'TRUNCATED_MIDI';
    throw e;
  }
  const headerLen = buf.readUInt32BE(4);
  if (headerLen < 6 || 8 + headerLen > buf.length) {
    const e = new Error(`bad MThd length ${headerLen} (file is ${buf.length} bytes)`);
    e.code = 'TRUNCATED_MIDI';
    throw e;
  }
  const format = buf.readUInt16BE(8);
  const trackCount = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);

  // A parse that loses tracks, truncates a chunk or reads an impossible value
  // must SAY SO. The reader is what cw_check_quantize and every "did the import
  // land" check rely on, and a clean-looking object built from half a file is
  // worse than an error.
  const warnings = [];
  // Structured flags, so "incomplete" never depends on the English wording of a
  // warning. A container problem and an event-level problem are tracked apart.
  let containerIncomplete = false;
  if (format > 2) {
    warnings.push(`format ${format} is not a Standard MIDI File format (0, 1 or 2)`);
    containerIncomplete = true;
  }
  if (format === 0 && trackCount !== 1) {
    // Format 0 is defined as exactly one track. More than one means the header
    // and the chunk stream disagree, and at least one chunk cannot be trusted.
    warnings.push(`format 0 must contain exactly one track, but the header declares ${trackCount}`);
    containerIncomplete = true;
  }
  if (division === 0) {
    warnings.push('division (ticks per quarter note) is 0, which makes every tick ambiguous');
    containerIncomplete = true;
  }

  const tracks = [];
  let off = 8 + headerLen;
  for (let t = 0; t < trackCount && off + 8 <= buf.length; t++) {
    if (buf.slice(off, off + 4).toString('ascii') !== 'MTrk') {
      warnings.push(`track ${t}: expected an MTrk chunk at byte ${off}, found `
        + `"${buf.slice(off, off + 4).toString('latin1')}"`);
      containerIncomplete = true;
      break;
    }
    const len = buf.readUInt32BE(off + 4);
    const available = Math.max(0, buf.length - (off + 8));
    if (len > available) {
      warnings.push(`track ${t}: declares ${len} bytes but only ${available} are present; `
        + 'parsed the available part');
      containerIncomplete = true;
    }
    const body = buf.slice(off + 8, Math.min(off + 8 + len, buf.length));
    const parsed = parseTrack(body);
    if (parsed.warnings && parsed.warnings.length) {
      for (const w of parsed.warnings) warnings.push(`track ${t}: ${w}`);
    }
    tracks.push(parsed);
    off += 8 + len;
  }
  if (tracks.length < trackCount) {
    warnings.push(`header declares ${trackCount} track(s) but only ${tracks.length} could be parsed`);
    containerIncomplete = true;
  }
  const out = { format, division, tracks, trackCountDeclared: trackCount };
  if (warnings.length) {
    out.warnings = warnings;
    out.incomplete = containerIncomplete
      || tracks.some((t) => t.incomplete)
      || tracks.some((t) => t.warnings && t.warnings.length);
  }
  return out;
}

function parseTrack(body) {
  let i = 0;
  let tick = 0;
  let status = 0;
  let name = null;
  const warnings = [];
  // Reported separately from the prose: read() used to infer "incomplete" from
  // warning text, so a warning that did not happen to contain "truncat" (the two
  // delta-time cases) left incomplete:false.
  let incomplete = false;

  /**
   * Reject a data byte that is not 7-bit.
   *
   * Channel and system-common data bytes are defined as 0..127. A byte with the
   * high bit set means the stream is corrupt (a lost status byte, an
   * off-by-one), so masking it and continuing produced a clean-looking event
   * that was not in the file — the round-4 fuzz got pitch 180 back as pitch 52.
   * Stop the track here instead, keeping the events already decoded.
   */
  const badDataByte = (what, b) => {
    warnings.push(`${what} at tick ${tick} has data byte 0x${b.toString(16)} (> 0x7f): `
      + 'the stream is corrupt, so the rest of this track was not read');
    incomplete = true;
  };

  // Every channel/system event has a fixed data-byte count. Reading past the end
  // used to yield `undefined`, which arithmetic turned into 0 — a note-on with no
  // velocity looked like velocity 0 (a note-off), a program change with no byte
  // looked like program 0, all without a word.
  const ensure = (n, what) => {
    if (i + n <= body.length) return true;
    warnings.push(`truncated ${what} at tick ${tick}: needs ${n} data byte(s), ${body.length - i} left`);
    incomplete = true;
    return false;
  };
  // Index of the first data byte at/after `from` that is not 7-bit, or -1.
  const findBadDataByte = (from, n) => {
    for (let k = 0; k < n; k++) if (body[from + k] > 0x7f) return from + k;
    return -1;
  };
  const channelOf = { };   // channel -> event count, so a track's channel is visible
  const notes = [];
  const ccs = [];
  const pending = new Map();  // "ch:pitch" -> { tick, velocity }

  // `complete` is false when the track ends in the middle of a VLQ (the last
  // byte still had the continuation bit). That used to be indistinguishable from
  // a value of 0, so a truncated delta/length was read as a number.
  const readVlqInfo = () => {
    let v = 0;
    let n = 0;
    let complete = false;
    while (i < body.length) {
      const b = body[i++];
      v = (v << 7) | (b & 0x7f);
      if (++n > 4) {
        // A delta time is at most four bytes. Letting a fifth through shifted
        // the value into signed 32-bit and produced a NEGATIVE tick, so a
        // malformed file read back with negative positions instead of an error.
        const e = new Error(`malformed variable-length quantity at byte ${i} (more than 4 bytes)`);
        e.code = 'BAD_VLQ';
        throw e;
      }
      if (!(b & 0x80)) { complete = true; break; }
    }
    return { value: v, complete };
  };
  const readVlq = () => readVlqInfo().value;

  while (i < body.length) {
    const dt = readVlqInfo();
    if (!dt.complete) {
      warnings.push(`truncated delta time: the track ends inside it at tick ${tick}`);
      incomplete = true;
      break;
    }
    tick += dt.value;
    if (i >= body.length) {
      warnings.push(`truncated event: a delta time at tick ${tick} is not followed by an event`);
      incomplete = true;
      break;
    }
    let b = body[i];

    if (b & 0x80) { status = b; i++; }
    else if (status === 0) {
      // No running status is in force (a meta, sysex or system event cancelled
      // it), so this byte has no event type and the rest of the track cannot be
      // decoded. Stop here instead of walking off the end — but say so: the old
      // silent `break` reported a track cut short in the middle as complete.
      warnings.push(`orphan data byte 0x${b.toString(16)} at tick ${tick}: no running status is `
        + 'in force, so this event and everything after it could not be read');
      incomplete = true;
      break;
    }
    // else: running status, reuse `status`

    // System common / real time (0xF1-0xFE) is handled BEFORE the channel
    // switch: masking to 0xF0 would fold every one of them into "unknown" and
    // consume a single byte, which desynchronised the rest of the track.
    if (status >= 0xf1 && status <= 0xfe) {
      const dataBytes = (status === 0xf1 || status === 0xf3) ? 1
        : (status === 0xf2) ? 2
          : 0;
      if (!ensure(dataBytes, `system message 0x${status.toString(16)}`)) break;
      const bad = findBadDataByte(i, dataBytes);
      if (bad >= 0) {
        badDataByte(`system message 0x${status.toString(16)}`, body[bad]);
        i = bad;
        break;
      }
      i += dataBytes;
      status = 0;   // these cancel running status
      continue;
    }

    const type = status & 0xf0;
    const ch = status & 0x0f;

    if (status === 0xff) {
      if (i >= body.length) { warnings.push(`truncated meta event at tick ${tick} (no type byte)`); incomplete = true; break; }
      const meta = body[i++];
      const lenInfo = readVlqInfo();
      if (!lenInfo.complete) {
        warnings.push(`truncated meta length at tick ${tick} (type 0x${meta.toString(16)})`);
        incomplete = true;
        break;
      }
      const l = lenInfo.value;
      const available = body.length - i;
      if (l > available) {
        // A meta payload shorter than declared means the file was cut or the
        // length is corrupt. Keep the bytes that exist (a track name is still
        // useful) and stop: nothing after a truncated payload is trustworthy.
        warnings.push(`truncated meta 0x${meta.toString(16)} at tick ${tick}: declares ${l} `
          + `payload bytes but only ${available} are present`);
        if (meta === 0x03) name = body.slice(i).toString('utf8');
        incomplete = true;
        break;
      }
      const data = body.slice(i, i + l);
      i += l;
      if (meta === 0x03) name = data.toString('utf8');
      if (meta === 0x2f) break;
      // The spec cancels running status at a meta event. Keeping it made the next
      // data byte read as a meta TYPE with a bogus length, silently swallowing the
      // rest of the track.
      status = 0;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const lenInfo = readVlqInfo();
      if (!lenInfo.complete) {
        warnings.push(`truncated sysex length at tick ${tick}`);
        incomplete = true;
        break;
      }
      const available = body.length - i;
      if (lenInfo.value > available) {
        warnings.push(`truncated sysex at tick ${tick}: declares ${lenInfo.value} bytes but only `
          + `${available} are present`);
        incomplete = true;
        break;
      }
      i += lenInfo.value;
      status = 0;
      continue;
    }

    if (type === 0x90 || type === 0x80) {
      if (!ensure(2, 'note event')) break;
      // Data bytes are 7-bit. A high bit here means the stream is corrupt: the
      // old code masked the velocity (so a corrupt byte was reported as a valid
      // one) and only mentioned the pitch after the fact. Refuse both, and stop
      // the track rather than inventing an event that is not in the file.
      const bad = findBadDataByte(i, 2);
      if (bad >= 0) {
        badDataByte('note event', body[bad]);
        i = bad;
        break;
      }
      const pitch = body[i++];
      const vel = body[i++];
      channelOf[ch] = (channelOf[ch] || 0) + 1;
      const key = `${ch}:${pitch}`;
      if (type === 0x90 && vel > 0) {
        // A QUEUE per channel+pitch, not a single slot. Overlapping same-pitch
        // notes are legal MIDI (one-key retrigger, tremolo repeats), and the old
        // `pending.set` silently REPLACED the earlier onset — a real note
        // vanished from the read-back with unterminatedNotes still 0, so nothing
        // reported the loss. Confirmed by round-trip: onsets at 0 and 120 with
        // offs at 240 and 360 read back as one note.
        if (!pending.has(key)) pending.set(key, []);
        // The channel is recorded per note: a format-0 file (or any track that
        // mixes channels) otherwise loses which channel each note belonged to,
        // and a faithful round-trip becomes impossible.
        pending.get(key).push({ tick, velocity: vel, channel: ch + 1 });
      } else {
        // FIFO: a note-off closes the OLDEST still-open onset, which matches how
        // physical keys and every mainstream sequencer pair events.
        const queue = pending.get(key);
        if (queue && queue.length) {
          const start = queue.shift();
          notes.push({ tick: start.tick, pitch, velocity: start.velocity,
            duration: tick - start.tick, channel: start.channel });
          if (!queue.length) pending.delete(key);
        }
      }
    } else if (type === 0xb0) {
      if (!ensure(2, 'controller event')) break;
      const bad = findBadDataByte(i, 2);
      if (bad >= 0) {
        badDataByte('controller event', body[bad]);
        i = bad;
        break;
      }
      const controller = body[i++];
      const value = body[i++];
      channelOf[ch] = (channelOf[ch] || 0) + 1;
      // The channel is 1-based, the same convention as `channelOf`/`channels` and
      // as buildTrack()'s `channel`. Without it a track that mixes channels (a
      // format-0 file, or one SONAR merged) read back as a bag of CCs with no way
      // to tell which channel each originally addressed.
      ccs.push({ tick, channel: ch + 1, controller, value,
        describe: controller === CC.pan ? describePan(value) : undefined });
    } else if (type === 0xc0 || type === 0xd0) {
      if (!ensure(1, 'program change / channel pressure')) break;
      // A program change with a corrupt number used to be stepped over without
      // looking at the byte at all, so the patch silently became whatever the
      // masked value was.
      if (body[i] > 0x7f) {
        badDataByte(type === 0xc0 ? 'program change' : 'channel pressure', body[i]);
        break;
      }
      channelOf[ch] = (channelOf[ch] || 0) + 1;
      i += 1;
    } else if (type === 0xa0 || type === 0xe0) {
      if (!ensure(2, 'poly pressure / pitch bend')) break;
      const bad = findBadDataByte(i, 2);
      if (bad >= 0) {
        badDataByte(type === 0xa0 ? 'poly pressure' : 'pitch bend', body[bad]);
        i = bad;
        break;
      }
      channelOf[ch] = (channelOf[ch] || 0) + 1;
      i += 2;
    } else {
      i += 1;   // unknown; step past one byte so we cannot loop forever
    }
  }

  const channels = Object.entries(channelOf)
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => Number(c) + 1);

  // Notes whose note-off never arrived — a track that ends, or is truncated,
  // while a key is still down. Dropping them loses real content: a MIDI file
  // written by a sequencer that trims the tail, or one cut short during a bad
  // export, would silently come back short. Close them at the last tick and say
  // the duration is uncertain rather than pretending to know it.
  // `pending` maps channel:pitch to a QUEUE of onsets (see the note above), so
  // each entry here is an array. Reading `start.tick` off that array produced
  // undefined tick/velocity and a NaN duration — the note was still reported, so
  // the corruption was silent. Close every queued onset at the last tick.
  const unterminated = [];
  for (const [key, queue] of pending) {
    const [chStr, pitchStr] = key.split(':');
    for (const onset of queue) {
      unterminated.push({
        tick: onset.tick,
        pitch: Number(pitchStr),
        velocity: onset.velocity,
        duration: Math.max(1, tick - onset.tick),
        channel: onset.channel,
        unterminated: true,
      });
      channelOf[Number(chStr)] = (channelOf[Number(chStr)] || 0) + 1;
    }
  }
  if (unterminated.length) pushBytes(notes, unterminated);
  notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);

  const out = { name, channels, notes, ccs, unterminatedNotes: unterminated.length };
  if (incomplete) out.incomplete = true;
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** Compact description of a file, for a tool result. */
export function describe(path) {
  const m = read(path);
  const tracks = m.tracks.map((t) => ({
    name: t.name,
    channels: t.channels,
    notes: t.notes.length,
    ccs: t.ccs.length,
    pan: t.ccs.filter((c) => c.controller === CC.pan).map((c) => c.describe),
    volume: t.ccs.filter((c) => c.controller === CC.volume).map((c) => c.value),
    // Surfaced rather than hidden: a note with no note-off means the file was
    // trimmed or cut short, and its duration is a guess.
    unterminatedNotes: t.unterminatedNotes || undefined,
  }));
  const unterminated = tracks.reduce((a, t) => a + (t.unterminatedNotes || 0), 0);
  return {
    path,
    format: m.format,
    division: m.division,
    ...(m.trackCountDeclared !== undefined ? { trackCountDeclared: m.trackCountDeclared } : {}),
    ...(m.incomplete ? { incomplete: true } : {}),
    ...(m.warnings ? { warnings: m.warnings } : {}),
    tracks,
    ...(unterminated ? {
      warning: `${unterminated} note(s) have no note-off — the file ends (or was truncated) while `
        + 'a key was still down. Their durations are inferred from where the track stops.',
    } : {}),
  };
}
