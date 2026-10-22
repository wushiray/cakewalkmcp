// test/audit-regressions.test.mjs — one test per defect from the 2026-10-20
// release audit (F01–F15). These pin the failure MODE, not just the happy path:
// each one failed before the fix and would fail again if it were reverted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertMidiSent } from '../lib/live.js';
import { queryNotesSource } from '../lib/cal-script.js';
import { read, describe, buildTrack, write } from '../lib/midi-file.js';
import { convert } from '../lib/convert.js';
import { judgeQuantize } from '../lib/note-edit.js';
import { enablePort, configPath } from '../lib/midi-config.js';
import { cakescriptChannel } from '../lib/doctor.js';

const dir = mkdtempSync(join(tmpdir(), 'cw-audit-'));

function smf(headerTracks, chunks) {
  const hdr = Buffer.alloc(14);
  hdr.write('MThd', 0, 'ascii');
  hdr.writeUInt32BE(6, 4);
  hdr.writeUInt16BE(1, 8);
  hdr.writeUInt16BE(headerTracks, 10);
  hdr.writeUInt16BE(480, 12);
  return Buffer.concat([hdr, ...chunks]);
}
function chunk(body, declared = body.length) {
  const h = Buffer.alloc(8);
  h.write('MTrk', 0, 'ascii');
  h.writeUInt32BE(declared, 4);
  return Buffer.concat([h, body]);
}

// --- F01: a rejected send must not look like a delivered one ----------------
test('F01: a failed MIDI send raises instead of returning ok', () => {
  assert.throws(() => assertMidiSent({ ok: false, rc: 5, error: 'driver rejected' }, 'note-on'),
    (e) => e.code === 'MIDI_SEND_FAILED' && /driver rejected/.test(e.message));
  assert.throws(() => assertMidiSent({ ok: false, failed: 2, sent: 0 }, 'chord'),
    (e) => e.code === 'MIDI_SEND_FAILED');
  // the success path must still pass through untouched
  const ok = { ok: true, sent: 1 };
  assert.equal(assertMidiSent(ok, 'note-on'), ok);
});

// --- F02: an allowed track index must not be silently retargeted -----------
test('F02: queryNotes keeps trackIndex 200 instead of clamping to 127', () => {
  const src = queryNotesSource({ trackIndex: 200 });
  assert.match(src, /\b200\b/, 'the generated CAL must name track 200');
  assert.doesNotMatch(src.split('Format:')[0], /\b127\b/,
    'it must not have been clamped to 127');
});

// --- F03: structural damage must be reported --------------------------------
test('F03: fewer tracks than the header declares is reported, not hidden', () => {
  const body = Buffer.from([0x00, 0x90, 0x3c, 0x64, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00]);
  const p = join(dir, 'missing-track.mid');
  writeFileSync(p, smf(2, [chunk(body)]));
  const d = describe(p);
  assert.equal(d.tracks.length, 1);
  assert.equal(d.trackCountDeclared, 2);
  assert.equal(d.incomplete, true);
  assert.ok(d.warnings.some((w) => /declares 2/.test(w)));
});

test('F03: a track chunk longer than the file is reported', () => {
  const body = Buffer.from([0x00, 0x90, 0x3c, 0x64]);
  const p = join(dir, 'short-chunk.mid');
  writeFileSync(p, smf(1, [chunk(body, 1024)]));
  const d = describe(p);
  assert.ok(d.warnings.some((w) => /declares 1024 bytes/.test(w)));
});

test('F03: a truncated CC and an out-of-range CC value are both reported', () => {
  const truncated = join(dir, 'cc-truncated.mid');
  writeFileSync(truncated, smf(1, [chunk(Buffer.from([0x00, 0xb0, 0x07]))]));
  const t = read(truncated).tracks[0];
  assert.equal(t.ccs.length, 0, 'an incomplete CC must not become a null-valued record');
  assert.ok(t.warnings.some((w) => /truncated controller/.test(w)));

  const outOfRange = join(dir, 'cc-255.mid');
  writeFileSync(outOfRange, smf(1, [chunk(Buffer.from([0x00, 0xb0, 0x07, 0xff, 0x00, 0xff, 0x2f, 0x00]))]));
  const t2 = read(outOfRange).tracks[0];
  // Recovery is refused rather than masked: fabricating a 7-bit value would be
  // silent corruption of a malformed input, so the reader stops at the invalid
  // byte, emits no CC, and surfaces the problem via warnings + incomplete.
  assert.equal(t2.ccs.length, 0, 'an invalid 8-bit CC must not be synthesized');
  assert.ok(t2.warnings.length > 0, 'the invalid CC must be reported');
  assert.equal(t2.incomplete, true, 'the read must be marked incomplete');
});

test('F03: division 0 and an impossible format are reported', () => {
  const body = Buffer.from([0x00, 0xff, 0x2f, 0x00]);
  const p = join(dir, 'bad-header.mid');
  const hdr = Buffer.alloc(14);
  hdr.write('MThd', 0, 'ascii'); hdr.writeUInt32BE(6, 4);
  hdr.writeUInt16BE(7, 8); hdr.writeUInt16BE(1, 10); hdr.writeUInt16BE(0, 12);
  writeFileSync(p, Buffer.concat([hdr, chunk(body)]));
  const d = describe(p);
  assert.ok(d.warnings.some((w) => /format 7/.test(w)));
  assert.ok(d.warnings.some((w) => /division/.test(w)));
});

// --- F04: raw event bytes must be structurally valid ------------------------
test('F04: a note-on with no data bytes is refused, not written', () => {
  for (const bytes of [[0x90], [0x90, 60], [0x90, 200, 100], [0xc0], [0x90, 60, 0x7f, 0x00]]) {
    assert.throws(() => buildTrack([{ tick: 0, bytes }], { channel: 1 }),
      `${JSON.stringify(bytes)} must be refused`);
  }
  assert.doesNotThrow(() => buildTrack([{ tick: 0, bytes: [0x90, 60, 100] }], { channel: 1 }));
});

// --- F05: per-note channel survives ----------------------------------------
test('F05: notes carry their channel', () => {
  const p = join(dir, 'two-channels.mid');
  write(p, { tracks: [
    { channel: 1, events: [
      { tick: 0, bytes: [0x90, 60, 100] }, { tick: 240, bytes: [0x80, 60, 0] },
      { tick: 0, bytes: [0x91, 60, 70] }, { tick: 480, bytes: [0x81, 60, 0] },
    ] },
  ] });
  const notes = read(p).tracks[1].notes;
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.channel).sort(), [1, 2]);
});

// --- F06: overflow in convert is an error ----------------------------------
test('F06: convert refuses inputs whose result overflows', () => {
  assert.throws(() => convert({ bar: 1e308 }), (e) => e.code === 'TICK_OUT_OF_RANGE');
  assert.throws(() => convert({ seconds: '9'.repeat(400) }), (e) => e.code === 'TICK_OUT_OF_RANGE');
  assert.throws(() => convert({ time: '9'.repeat(400) + ':01:000' }), (e) => e.code === 'TICK_OUT_OF_RANGE');
  assert.throws(() => convert({ ticks: 480 }, { timeSig: [1, 1e308] }), (e) => e.code === 'BAD_TIME_SIG');
  assert.equal(convert({ bar: 2 }, { ppq: 960 }).tick, 3840);
});

// --- F07: doctor reads the key dispatch actually publishes ------------------
test('F07: doctor reports detected but unimplemented T1 honestly', () => {
  const ch = cakescriptChannel({ transports: { 'window-message': { available: true, detail: 'x' } } });
  assert.equal(ch.verdict, 'degraded');
  assert.equal(ch.detail.available, false);
  const off = cakescriptChannel({ transports: { 'window-message': { available: false } } });
  assert.equal(off.verdict, 'unavailable');
});

// --- F10: a backup that cannot be written stops the edit -------------------
test('F10: enablePort refuses to write when the backup cannot be created', () => {
  const appdata = join(dir, 'appdata-f10');
  const iniDir = join(appdata, 'Cakewalk', 'Sonar');
  mkdirSync(iniDir, { recursive: true });
  const ini = join(iniDir, 'TTSSEQ.INI');
  writeFileSync(ini, '[MIDI Input Devices]\r\nMaxInPort=-1\r\n');
  // make <ini>.bak a DIRECTORY so copyFileSync must fail
  mkdirSync(ini + '.bak');
  const saved = process.env.APPDATA;
  process.env.APPDATA = appdata;
  try {
    assert.throws(() => enablePort('New Port'), (e) => e.code === 'BACKUP_FAILED');
    assert.equal(readFileSync(ini, 'utf8'), '[MIDI Input Devices]\r\nMaxInPort=-1\r\n',
      'the configuration must be untouched');
  } finally {
    process.env.APPDATA = saved;
  }
});

// --- F14: negative ticks are not positions ---------------------------------
test('F14: judgeQuantize rejects negative ticks instead of proving them', () => {
  assert.throws(() => judgeQuantize({ before: [-119], after: [-120], grid: 120 }),
    (e) => e.code === 'BAD_TICKS');
  assert.doesNotThrow(() => judgeQuantize({ before: [0, 120], after: [0, 120], grid: 120 }));
});

// --- F15: an absurd track name is refused, not a stack overflow ------------
test('F15: a 150k-character track name is refused with a range error', () => {
  assert.throws(() => buildTrack([], { channel: 1, name: 'x'.repeat(150000) }),
    (e) => e instanceof RangeError && /1024/.test(e.message));
});

// --- empty track (a misspelled field) is surfaced --------------------------
test('write() warns about a track with no events', () => {
  const p = join(dir, 'empty-track.mid');
  const r = write(p, { tracks: [{ channel: 1, name: 'Typo', events: [] }] });
  assert.ok(r.warnings && r.warnings.some((w) => /no events/.test(w)));
});

// --- F15 (root cause): a large payload must not be spread into push() -------
test('F15: a 200k-byte sysex event does not overflow the stack', () => {
  const payload = new Array(200000).fill(0x41);
  // VLQ encode the length: 200000 = 0x30D40 -> 8c 9a 40
  const vlq = (n) => {
    const b = [n & 0x7f];
    n = Math.floor(n / 128);
    while (n > 0) { b.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    return b;
  };
  const bytes = [0xf0, ...vlq(payload.length), ...payload];
  const buf = buildTrack([{ tick: 0, bytes }], { channel: 1 });
  assert.ok(buf.length > payload.length, 'the event should be written, not rejected');
  assert.equal(buf[0], 0x4d); // 'M' of MTrk
});

// --- F15 (read path): closing 200k unterminated notes must not spread ------
test('F15: 200k unterminated notes read back without a stack overflow', () => {
  const N = 200000;
  const body = Buffer.alloc(N * 4 + 4);
  for (let k = 0; k < N; k++) {
    body[k * 4] = 0x00; body[k * 4 + 1] = 0x90; body[k * 4 + 2] = 60; body[k * 4 + 3] = 100;
  }
  body[N * 4] = 0x00; body[N * 4 + 1] = 0xff; body[N * 4 + 2] = 0x2f; body[N * 4 + 3] = 0x00;
  const p = join(dir, 'unterminated-200k.mid');
  writeFileSync(p, smf(1, [chunk(body)]));
  const r = read(p);
  assert.equal(r.tracks[0].notes.length, N);
  assert.equal(r.tracks[0].unterminatedNotes, N);
  assert.equal(r.tracks[0].notes[0].channel, 1);
});

// --- F03: a truncated meta must be reported --------------------------------
test('F03: a meta payload shorter than declared is reported', () => {
  const p = join(dir, 'meta-truncated.mid');
  // meta type 0x01 declares 127 bytes, three are present
  writeFileSync(p, smf(1, [chunk(Buffer.from([0x00, 0xff, 0x01, 0x7f, 0x41, 0x42, 0x43]))]));
  const d = describe(p);
  assert.equal(d.incomplete, true);
  assert.ok(d.warnings.some((w) => /truncated meta 0x1/.test(w)));
});

test('F03: a meta event with no type byte is reported', () => {
  const p = join(dir, 'meta-notype.mid');
  writeFileSync(p, smf(1, [chunk(Buffer.from([0x00, 0xff]))]));
  const d = describe(p);
  assert.equal(d.incomplete, true);
  assert.ok(d.warnings.some((w) => /no type byte/.test(w)));
});

// --- F03: every truncated event class must be flagged ----------------------
test('F03: truncated channel events and delta times set incomplete', () => {
  const cases = {
    'note-no-velocity': [0x00, 0x90, 0x3c],
    'program-no-data': [0x00, 0xc0],
    'bend-one-byte': [0x00, 0xe0, 0x00],
    'delta-truncated': [0x81],
    'delta-without-event': [0x00],
    'cc-no-value': [0x00, 0xb0, 0x07],
  };
  for (const [label, bytes] of Object.entries(cases)) {
    const p = join(dir, `${label}.mid`);
    writeFileSync(p, smf(1, [chunk(Buffer.from(bytes))]));
    const d = describe(p);
    assert.equal(d.incomplete, true, `${label} must be marked incomplete`);
    assert.ok(d.warnings && d.warnings.length > 0, `${label} must carry a warning`);
  }
});
