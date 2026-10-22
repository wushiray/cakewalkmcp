// test/midi-file.test.mjs — round-trip and structural tests for .mid read/write.
//
// The writer and reader are independent implementations of the same
// specification, so feeding one into the other is a real test: a byte written
// wrongly shows up as a wrong note, channel or position on the way back. It also
// exercises the running-status path in the reader, since the writer emits several
// consecutive events on one channel.
//
// The channel consistency check exists because a mismatch is silent: SONAR routes
// CC7/CC10 by the channel in the message, so notes on one channel and a mix on
// another import happily and put the volume on the wrong strip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as M from '../lib/midi-file.js';
import { tempFile } from './helpers.mjs';

// --- file structure ----------------------------------------------------------

test('write produces a valid format-1 file with a conductor track', () => {
  const path = tempFile('struct.mid');
  M.write(path, { bpm: 120, tracks: [{ name: 'A', channel: 1, program: 0, events: [] }] });
  const buf = readFileSync(path);

  assert.equal(buf.slice(0, 4).toString('ascii'), 'MThd');
  assert.equal(buf.readUInt32BE(4), 6, 'header length');
  assert.equal(buf.readUInt16BE(8), 1, 'format 1');
  assert.equal(buf.readUInt16BE(10), 2, 'one conductor + one track');
  assert.equal(buf.readUInt16BE(12), 480, 'ticks per quarter');
  assert.equal(buf.slice(14, 18).toString('ascii'), 'MTrk');
});

test('every declared chunk length matches the bytes that follow it', () => {
  const path = tempFile('chunks.mid');
  M.write(path, {
    bpm: 100,
    tracks: [
      { name: 'One', channel: 1, events: [{ tick: 0, bytes: M.on(0, 60, 100) }, { tick: 480, bytes: M.off(0, 60) }] },
      { name: 'Two', channel: 2, events: [{ tick: 240, bytes: M.on(1, 64, 90) }, { tick: 720, bytes: M.off(1, 64) }] },
    ],
  });
  const buf = readFileSync(path);
  let off = 14;
  let chunks = 0;
  while (off < buf.length) {
    assert.equal(buf.slice(off, off + 4).toString('ascii'), 'MTrk', `chunk ${chunks} magic`);
    const len = buf.readUInt32BE(off + 4);
    off += 8 + len;
    chunks++;
  }
  assert.equal(off, buf.length, 'chunks must consume the file exactly');
  assert.equal(chunks, 3);
});

test('a tempo meta event carries the right microseconds per quarter', () => {
  const path = tempFile('tempo.mid');
  M.write(path, { bpm: 96, tracks: [{ name: 'X', channel: 1, events: [] }] });
  const buf = readFileSync(path);
  // FF 51 03 then three bytes: 60_000_000 / 96 = 625000 = 0x0989C8
  const idx = buf.indexOf(Buffer.from([0xff, 0x51, 0x03]));
  assert.ok(idx > 0, 'tempo meta should be present');
  const us = (buf[idx + 3] << 16) | (buf[idx + 4] << 8) | buf[idx + 5];
  assert.equal(us, 625000);
});

// --- round trip --------------------------------------------------------------

test('write then read preserves pitch, velocity, channel and position', () => {
  const path = tempFile('roundtrip.mid');
  const notes = [
    { tick: 0, pitch: 60, velocity: 100, duration: 480 },
    { tick: 480, pitch: 64, velocity: 80, duration: 240 },
    { tick: 960, pitch: 67, velocity: 120, duration: 960 },
  ];
  M.write(path, {
    bpm: 120,
    tracks: [{
      name: 'Lead', channel: 3, program: 0,
      events: notes.flatMap((n) => [
        { tick: n.tick, bytes: M.on(2, n.pitch, n.velocity) },
        { tick: n.tick + n.duration, bytes: M.off(2, n.pitch) },
      ]),
    }],
  });

  const read = M.read(path);
  const track = read.tracks.find((t) => t.name === 'Lead');
  assert.equal(track.notes.length, 3);
  for (let i = 0; i < notes.length; i++) {
    assert.equal(track.notes[i].pitch, notes[i].pitch, `pitch ${i}`);
    assert.equal(track.notes[i].velocity, notes[i].velocity, `velocity ${i}`);
    assert.equal(track.notes[i].tick, notes[i].tick, `start ${i}`);
    assert.equal(track.notes[i].duration, notes[i].duration, `duration ${i}`);
  }
  assert.deepEqual(track.channels, [3], 'everything should be on channel 3');
});

test('notes are returned in time order even when written out of order', () => {
  const path = tempFile('order.mid');
  M.write(path, {
    bpm: 120,
    tracks: [{ name: 'S', channel: 1, events: [
      { tick: 960, bytes: M.on(0, 67, 100) }, { tick: 1200, bytes: M.off(0, 67) },
      { tick: 0, bytes: M.on(0, 60, 100) }, { tick: 240, bytes: M.off(0, 60) },
      { tick: 480, bytes: M.on(0, 64, 100) }, { tick: 720, bytes: M.off(0, 64) },
    ]}],
  });
  const track = M.read(path).tracks.find((t) => t.name === 'S');
  assert.deepEqual(track.notes.map((n) => n.tick), [0, 480, 960]);
  assert.deepEqual(track.notes.map((n) => n.pitch), [60, 64, 67]);
});

test('the writer sorts events by tick regardless of insertion order', () => {
  const path = tempFile('sorted.mid');
  M.write(path, {
    bpm: 120,
    tracks: [{ name: 'S', channel: 1, events: [
      { tick: 960, bytes: M.on(0, 67, 100) },
      { tick: 0, bytes: M.on(0, 60, 100) },
    ]}],
  });
  const track = M.read(path).tracks.find((t) => t.name === 'S');
  assert.equal(track.notes[0].pitch, 60, 'the tick-0 note comes first');
});

test('CC7 and CC10 round-trip with their pan position described', () => {
  const path = tempFile('mix.mid');
  M.write(path, {
    bpm: 120,
    tracks: [{ name: 'Bass', channel: 2, program: 33, mix: { volume: 112, pan: 46 }, events: [] }],
  });
  const track = M.read(path).tracks.find((t) => t.name === 'Bass');
  const vol = track.ccs.filter((c) => c.controller === 7);
  const pan = track.ccs.filter((c) => c.controller === 10);
  assert.equal(vol.length, 1);
  assert.equal(vol[0].value, 112);
  assert.equal(pan.length, 1);
  assert.equal(pan[0].value, 46);
  assert.equal(pan[0].describe, '28% left');
});

test('a mix at tick 0 comes before any note, which is what makes SONAR adopt it', () => {
  const path = tempFile('mixfirst.mid');
  M.write(path, {
    bpm: 120,
    tracks: [{ name: 'X', channel: 1, mix: { volume: 100, pan: 64 },
      events: [{ tick: 0, bytes: M.on(0, 60, 100) }, { tick: 480, bytes: M.off(0, 60) }] }],
  });
  const track = M.read(path).tracks.find((t) => t.name === 'X');
  assert.ok(track.ccs.every((c) => c.tick === 0), 'the CCs sit at tick 0');
  const firstNonMeta = track.notes[0];
  assert.ok(track.ccs.length === 2 && firstNonMeta.tick === 0);
});

test('program change is emitted per track so the patch is preserved', () => {
  const path = tempFile('program.mid');
  M.write(path, {
    bpm: 120,
    tracks: [
      { name: 'P', channel: 1, program: 0, events: [] },
      { name: 'B', channel: 2, program: 33, events: [] },
      { name: 'D', channel: 10, program: 0, events: [] },
    ],
  });
  const buf = readFileSync(path);
  // 0xC0|ch for channel 0,1,9 -> c0, c1, c9 present in the byte stream
  for (const status of [0xc0, 0xc1, 0xc9]) {
    assert.ok(buf.includes(status), `expected a program change status 0x${status.toString(16)}`);
  }
});

// --- channel consistency -----------------------------------------------------

test('write warns when a track mixes two channels', () => {
  const path = tempFile('mismatch.mid');
  const r = M.write(path, {
    bpm: 120,
    tracks: [{ name: 'bad', channel: 5, mix: { volume: 90 },
      events: [{ tick: 0, bytes: M.on(2, 60, 100) }, { tick: 480, bytes: M.off(2, 60) }] }],
  });
  assert.ok(r.warnings && r.warnings.length === 1, 'a channel mismatch must be reported');
  assert.match(r.warnings[0], /channel\(s\) 3/);
  assert.match(r.warnings[0], /declared as channel 5/);
});

test('write reports no warnings for a consistent track', () => {
  const path = tempFile('consistent.mid');
  const r = M.write(path, {
    bpm: 120,
    tracks: [{ name: 'good', channel: 5, mix: { volume: 90, pan: 64 },
      events: [{ tick: 0, bytes: M.on(4, 60, 100) }, { tick: 480, bytes: M.off(4, 60) }] }],
  });
  assert.equal(r.warnings, undefined);
});

test('the channel in the file matches the channel declared, notes and CCs alike', () => {
  const path = tempFile('chmatch.mid');
  M.write(path, {
    bpm: 120,
    tracks: [{ name: 'X', channel: 5, program: 10, mix: { volume: 90, pan: 64 },
      events: [{ tick: 0, bytes: M.on(4, 60, 100) }, { tick: 480, bytes: M.off(4, 60) }] }],
  });
  const track = M.read(path).tracks.find((t) => t.name === 'X');
  assert.deepEqual(track.channels, [5], 'one channel only: notes, CC and program all on 5');
});

// --- reader robustness -------------------------------------------------------

test('read rejects a file that is not MIDI', () => {
  const path = tempFile('notmidi.bin', 'this is not a midi file at all');
  assert.throws(() => M.read(path), (e) => e.code === 'NOT_MIDI');
});

test('read survives a truncated track without throwing', () => {
  const path = tempFile('trunc.mid');
  M.write(path, { bpm: 120, tracks: [{ name: 'T', channel: 1,
    events: [{ tick: 0, bytes: M.on(0, 60, 100) }, { tick: 480, bytes: M.off(0, 60) }] }] });
  const buf = readFileSync(path);
  const cut = buf.slice(0, buf.length - 6);
  const p2 = tempFile('trunc2.mid', cut);
  // Must not throw: a short read is a normal outcome for a partially written file.
  const r = M.read(p2);
  assert.ok(Array.isArray(r.tracks));
});

test('read handles running status (consecutive events sharing a status byte)', () => {
  // The writer emits a full status byte each time, so build the running-status
  // case by hand: ch1 note-ons with the status byte given once.
  const body = [
    0x00, 0x90, 60, 100,   // note on, status present
    0x60, 64, 100,         // running status: note on again, no status byte
    0x60, 67, 100,         // and again
    0x81, 0x40, 60, 0,     // delta 192, note off 60 (full status)
  ];
  const chunk = Buffer.from([...body, 0x00, 0xff, 0x2f, 0x00]);
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(480, 12);
  const len = Buffer.alloc(8);
  len.write('MTrk', 0, 'ascii');
  len.writeUInt32BE(chunk.length, 4);
  const path = tempFile('running.mid', Buffer.concat([header, len, chunk]));

  const r = M.read(path);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0].notes.length, 3, 'all three note-ons should be read');
  assert.deepEqual(r.tracks[0].notes.map((n) => n.pitch), [60, 64, 67]);
});

// --- describe ----------------------------------------------------------------

test('describe summarises a file without needing includeNotes', () => {
  const path = tempFile('desc.mid');
  M.write(path, {
    bpm: 120,
    tracks: [
      { name: 'Melody', channel: 1, program: 0, mix: { volume: 100, pan: 64 },
        events: [{ tick: 0, bytes: M.on(0, 72, 100) }, { tick: 240, bytes: M.off(0, 72) }] },
      { name: 'Bass', channel: 2, program: 33, mix: { volume: 112, pan: 46 },
        events: [{ tick: 0, bytes: M.on(1, 36, 96) }, { tick: 480, bytes: M.off(1, 36) }] },
    ],
  });
  const d = M.describe(path);
  assert.equal(d.format, 1);
  assert.equal(d.division, 480);
  const melody = d.tracks.find((t) => t.name === 'Melody');
  assert.equal(melody.notes, 1);
  assert.deepEqual(melody.channels, [1]);
  assert.deepEqual(melody.pan, ['centre']);
  assert.deepEqual(melody.volume, [100]);
  const bass = d.tracks.find((t) => t.name === 'Bass');
  assert.deepEqual(bass.pan, ['28% left']);
});

test('a track with no name still round-trips (the conductor has none)', () => {
  const path = tempFile('noname.mid');
  M.write(path, { bpm: 120, tracks: [{ channel: 1, events: [{ tick: 0, bytes: M.on(0, 60, 100) }] }] });
  const d = M.describe(path);
  assert.equal(d.tracks[0].name, null, 'the conductor');
  assert.ok(d.tracks.some((t) => t.notes === 1), 'the unnamed track still carries its note');
});

// --- overlapping same-pitch notes (audit F1) ---------------------------------
//
// The pending map used to hold ONE onset per channel+pitch, so a legal
// retrigger (tremolo, one-key repeat) silently REPLACED the earlier onset and
// the read-back lost a real note with unterminatedNotes still 0. FIFO pairing
// fixes it; this pins the exact sequence from the audit.

test('overlapping same-pitch notes both survive the round trip (F1)', () => {
  const events = [
    { tick: 0, bytes: [0x90, 60, 100] },
    { tick: 120, bytes: [0x90, 60, 100] },
    { tick: 240, bytes: [0x80, 60, 0] },
    { tick: 360, bytes: [0x80, 60, 0] },
  ];
  const path = tempFile('overlap.mid');
  M.write(path, { bpm: 120, tracks: [{ channel: 1, events }] });
  const r = M.read(path);
  const notes = r.tracks[1].notes;
  assert.equal(notes.length, 2, 'both onsets must survive');
  assert.deepEqual(notes.map((n) => [n.tick, n.duration]), [[0, 240], [120, 240]]);
  assert.equal(r.tracks[1].unterminatedNotes, 0);
});

test('three overlapping onsets close in FIFO order', () => {
  const events = [
    { tick: 0, bytes: [0x90, 60, 100] },
    { tick: 50, bytes: [0x90, 60, 90] },
    { tick: 100, bytes: [0x90, 60, 80] },
    { tick: 150, bytes: [0x80, 60, 0] },
    { tick: 200, bytes: [0x80, 60, 0] },
    { tick: 300, bytes: [0x80, 60, 0] },
  ];
  const path = tempFile('overlap3.mid');
  M.write(path, { bpm: 120, tracks: [{ channel: 1, events }] });
  const r = M.read(path);
  const notes = r.tracks[1].notes;
  assert.equal(notes.length, 3);
  // FIFO: the first off closes the tick-0 onset, and so on. Velocities follow.
  assert.deepEqual(notes.map((n) => [n.tick, n.duration, n.velocity]),
    [[0, 150, 100], [50, 150, 90], [100, 200, 80]]);
});
