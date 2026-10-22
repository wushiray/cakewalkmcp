// test/release-midi-regressions.test.mjs — permanent pins for the release
// boundary fixes in lib/midi-file.js. Each test is a minimal, hand-built file so
// the failure it describes cannot drift back in unnoticed.
//
// Nothing here asserts on warning WORDING; the point of the fix is that
// "incomplete" comes from structured flags, so the assertions use those.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../lib/midi-file.js';
import { tempFile } from './helpers.mjs';

// --- minimal file builders ---------------------------------------------------

function smf(format, division, chunks) {
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(format, 8);
  header.writeUInt16BE(chunks.length, 10);
  header.writeUInt16BE(division, 12);
  return Buffer.concat([header, ...chunks.map((body) => {
    const head = Buffer.alloc(8);
    head.write('MTrk', 0, 'ascii');
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  })]);
}

function midi(name, buf) {
  return tempFile(name, buf);
}

const EOT = [0x00, 0xff, 0x2f, 0x00];

// --- container checks --------------------------------------------------------

test('an impossible format is reported as incomplete', () => {
  const path = midi('fmt7.mid', smf(7, 480, [Buffer.from([...EOT])]));
  const r = M.read(path);
  assert.equal(r.format, 7);
  assert.ok(r.warnings && r.warnings.length, 'a warning must be present');
  assert.equal(r.incomplete, true);

  const d = M.describe(path);
  assert.equal(d.incomplete, true);
  assert.ok(d.warnings.length);
});

test('division 0 is reported as incomplete', () => {
  const path = midi('div0.mid', smf(1, 0, [Buffer.from([...EOT])]));
  const r = M.read(path);
  assert.equal(r.division, 0);
  assert.ok(r.warnings.length);
  assert.equal(r.incomplete, true);
  assert.equal(M.describe(path).incomplete, true);
});

test('format 0 with more than one track is reported as incomplete', () => {
  const path = midi('fmt0multi.mid', smf(0, 480, [
    Buffer.from([...EOT]),
    Buffer.from([0x00, 0x90, 60, 100, ...EOT]),
  ]));
  const r = M.read(path);
  assert.equal(r.format, 0);
  assert.ok(r.warnings.length);
  assert.equal(r.incomplete, true);
  assert.equal(M.describe(path).incomplete, true);
});

// --- event-level checks ------------------------------------------------------

test('an orphan running-status data byte is reported, not silently dropped', () => {
  // Delta 0, then a data byte with no status in force, then a valid note.
  const body = Buffer.from([0x00, 60, 100, 0x00, 0x90, 64, 100, ...EOT]);
  const path = midi('orphan.mid', smf(1, 480, [body]));
  const r = M.read(path);
  assert.equal(r.tracks[0].notes.length, 0, 'the orphan cannot become a note');
  assert.ok(r.tracks[0].warnings && r.tracks[0].warnings.length);
  assert.equal(r.incomplete, true);
  assert.equal(M.describe(path).incomplete, true);
});

test('a mid-track channel data byte above 127 is refused, keeping earlier events', () => {
  // note on 60/100, then a note on whose velocity byte has the high bit set.
  const body = Buffer.from([
    0x00, 0x90, 60, 100,
    0x60, 0x90, 64, 200,
    0x60, 0x80, 60, 0,
    ...EOT,
  ]);
  const path = midi('badvel.mid', smf(1, 480, [body]));
  const r = M.read(path);
  const track = r.tracks[0];
  assert.equal(track.notes.length, 1, 'the complete note before the corruption survives');
  assert.deepEqual(track.notes.map((n) => [n.pitch, n.velocity]), [[60, 100]]);
  assert.equal(track.notes.some((n) => n.velocity > 127 || n.velocity < 0), false);
  assert.ok(track.warnings.length && track.incomplete);
  assert.equal(r.incomplete, true);
});

test('a program change with a corrupt number is reported', () => {
  const body = Buffer.from([0x00, 0xc0, 0x85, ...EOT]);
  const r = M.read(midi('badpc.mid', smf(1, 480, [body])));
  assert.ok(r.tracks[0].warnings.length);
  assert.equal(r.incomplete, true);
});

test('a pitch-bend byte above 127 is reported', () => {
  const body = Buffer.from([0x00, 0xe0, 0x00, 0x90, ...EOT]);
  const r = M.read(midi('badbend.mid', smf(1, 480, [body])));
  assert.ok(r.tracks[0].warnings.length);
  assert.equal(r.incomplete, true);
});

test('a controller byte above 127 is reported', () => {
  const body = Buffer.from([0x00, 0xb0, 0x87, 0x80, ...EOT]);
  const r = M.read(midi('badcc.mid', smf(1, 480, [body])));
  assert.equal(r.tracks[0].ccs.length, 0, 'no masked CC is invented');
  assert.ok(r.tracks[0].warnings.length);
  assert.equal(r.incomplete, true);
});

// --- writer-side structure ---------------------------------------------------

test('a meta length VLQ without a terminating byte is rejected', () => {
  assert.throws(() => M.buildTrack([{ tick: 0, bytes: [0xff, 0x01, 0x80] }]), RangeError);
});

test('a sysex length VLQ without a terminating byte is rejected', () => {
  assert.throws(() => M.buildTrack([{ tick: 0, bytes: [0xf0, 0x80] }]), RangeError);
});

test('a meta type with the high bit set is rejected', () => {
  assert.throws(() => M.buildTrack([{ tick: 0, bytes: [0xff, 0x90, 0x00] }]), RangeError);
});

test('a system-common data byte above 127 is rejected', () => {
  assert.throws(() => M.buildTrack([{ tick: 0, bytes: [0xf2, 0x00, 0x80] }]), RangeError);
});

test('an end-of-track meta with a payload is rejected', () => {
  assert.throws(() => M.buildTrack([{ tick: 0, bytes: [0xff, 0x2f, 0x01, 0x00] }]), RangeError);
});

test('buildTrack refuses a caller-supplied EOT instead of losing later notes', () => {
  const events = [
    { tick: 0, bytes: M.on(0, 60, 100) },
    { tick: 240, bytes: [0xff, 0x2f, 0x00] },
    { tick: 480, bytes: M.off(0, 60) },
  ];
  assert.throws(() => M.buildTrack(events), RangeError);
  // The caller-supplied data itself is untouched.
  assert.deepEqual(events[1].bytes, [0xff, 0x2f, 0x00]);
});

test('legitimate large meta and sysex payloads still write and read', () => {
  const big = Buffer.alloc(20000, 0x41);
  const events = [
    { tick: 0, bytes: [0xff, 0x01, ...vlqBytes(big.length), ...big] },
    { tick: 0, bytes: [0xf0, ...vlqBytes(big.length), ...big] },
    { tick: 0, bytes: M.on(0, 60, 100) },
    { tick: 480, bytes: M.off(0, 60) },
  ];
  const track = M.buildTrack(events);   // throws if the payload validation is too strict
  const path = midi('big.mid', smf(1, 480, [track.slice(8)]));
  const r = M.read(path);
  assert.equal(r.tracks[0].notes.length, 1);
  assert.deepEqual(r.tracks[0].notes.map((n) => [n.pitch, n.duration]), [[60, 480]]);
  assert.equal(r.tracks[0].warnings, undefined);
  assert.equal(r.incomplete, undefined);
});

function vlqBytes(n) {
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  return out;
}

// --- CC channel attribution --------------------------------------------------

test('CCs carry a 1-based channel so a mixed-channel track stays separable', () => {
  const body = Buffer.from([
    0x00, 0xb0, 0x07, 100,
    0x00, 0xb2, 0x0a, 40,
    0x00, 0xb0, 0x0a, 64,
    ...EOT,
  ]);
  const r = M.read(midi('cchan.mid', smf(0, 480, [body])));
  const ccs = r.tracks[0].ccs;
  assert.equal(ccs.length, 3);
  assert.deepEqual(ccs.map((c) => c.channel), [1, 3, 1]);
  assert.deepEqual(ccs.map((c) => c.controller), [7, 10, 10]);
  assert.deepEqual(ccs.map((c) => c.value), [100, 40, 64]);
  // Existing fields are untouched.
  assert.equal(ccs[1].describe, '38% left');
});

test('M.write keeps default overwrite and guards with overwrite: false', async () => {
  const { readFileSync } = await import('node:fs');
  const p = tempFile('default-overwrite.mid');
  M.write(p, { tracks: [{ name: 'before', events: [] }] });
  const first = readFileSync(p);
  M.write(p, { tracks: [{ name: 'after', events: [] }] });
  assert.notDeepEqual(readFileSync(p), first);
  const q = tempFile('exclusive-create.mid');
  M.write(q, { tracks: [{ name: 'kept', events: [] }], overwrite: false });
  const kept = readFileSync(q);
  assert.throws(() => M.write(q, { tracks: [{ name: 'blocked', events: [] }], overwrite: false }), { code: 'FILE_EXISTS', path: q });
  assert.deepEqual(readFileSync(q), kept);
});
