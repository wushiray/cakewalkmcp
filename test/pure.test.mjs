// test/pure.test.mjs — pure functions: the maths and encodings the rest builds on.
//
// These are the cheapest tests and the ones most likely to catch a real mistake,
// because every one of these functions has a wrong-looking-but-plausible
// alternative: a 0-based vs 1-based channel, a 64-centred vs 0-centred pan, an
// off-by-one in a bit shift. Two of those were actual bugs found during
// development (channel numbering in midi-file.js, and the element-vs-frame
// coordinate space), so the tests below pin the correct behaviour explicitly.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../lib/midi-file.js';
import * as mix from '../lib/mixer.js';
import * as ui from '../lib/track-ui.js';
import * as c from '../lib/convert.js';
import * as ne from '../lib/note-edit.js';
import { formatOf } from '../lib/plugins.js';

// --- MIDI status byte construction ------------------------------------------

test('noteOn sets 0x90 plus the channel nibble', () => {
  assert.deepEqual(M.on(0, 60, 100), [0x90, 60, 100]);
  assert.deepEqual(M.on(15, 60, 100), [0x9f, 60, 100]);
  // A caller passing a 1-based channel by mistake must not silently produce a
  // wrong channel; 0 and 16 both land on nibble 0 either side of the wrap.
  assert.equal(M.on(16, 60, 100)[0] & 0x0f, 0);
});

test('noteOff is 0x80 on the same channel with velocity 0', () => {
  assert.deepEqual(M.off(0, 60), [0x80, 60, 0]);
  assert.deepEqual(M.off(9, 36), [0x89, 36, 0]);
});

test('controlChange encodes controller and value in two data bytes', () => {
  assert.deepEqual(M.cc(0, 7, 100), [0xb0, 7, 100]);
  assert.deepEqual(M.cc(1, 10, 64), [0xb1, 10, 64]);
});

test('programChange carries exactly one data byte', () => {
  assert.deepEqual(M.pc(0, 33), [0xc0, 33]);
  assert.equal(M.pc(0, 33).length, 2);
});

test('data bytes are masked to 7 bits, never leaking into the status byte', () => {
  // A value of 0xFF must not turn a note-on into something else.
  assert.deepEqual(M.on(0, 0xff, 0xff), [0x90, 0x7f, 0x7f]);
  assert.deepEqual(M.cc(0, 0xff, 0xff), [0xb0, 0x7f, 0x7f]);
});

test('MIDI CC numbers match the MIDI specification', () => {
  assert.equal(M.CC.volume, 7);
  assert.equal(M.CC.pan, 10);
  assert.equal(M.CC.expression, 11);
  assert.equal(M.CC.sustain, 64);
  assert.equal(M.CC.reverb, 91);
});

test('the CC table answers to both spellings, because three modules read it', () => {
  // midi-file.js uses CC.pan, mixer.js used CC.PAN. An undefined controller does
  // not throw — it masks to CC0, so pan silently became bank-select. Both
  // spellings must resolve, and to the same number.
  assert.equal(M.CC.pan, M.CC.PAN);
  assert.equal(M.CC.volume, M.CC.VOLUME);
  assert.equal(M.CC.pan, 10);
  assert.equal(M.CC.PAN, 10);
});

test('the bridge and the file writer agree on every controller number', async () => {
  const bridge = await import('../bridge/midi.js');
  for (const [upper, lower] of [['PAN', 'pan'], ['VOLUME', 'volume'], ['EXPRESSION', 'expression'],
    ['SUSTAIN', 'sustain'], ['MODULATION', 'modulation'], ['ALL_NOTES_OFF', 'allNotesOff']]) {
    assert.equal(bridge.CC[upper], M.CC[lower],
      `bridge/midi.js CC.${upper} and midi-file.js CC.${lower} disagree`);
  }
});

test('an undefined controller is refused rather than sent as CC0', () => {
  // The bug this guards against: controlChange(ch, undefined, 64) used to return
  // [0xb0|ch, 0, 64] — a bank select — with no error.
  assert.throws(() => M.cc(0, undefined, 64), (e) => e instanceof TypeError);
  assert.throws(() => M.cc(0, 'pan', 64), TypeError);
});

test('the bridge refuses an undefined controller too', async () => {
  const { controlChange } = await import('../bridge/midi.js');
  assert.throws(() => controlChange(1, undefined, 64), TypeError);
  assert.deepEqual(controlChange(1, 10, 64), [0xb0, 10, 64]);
});

// --- pan mapping -------------------------------------------------------------

test('panCC maps -1/0/+1 to 0/64/127', () => {
  assert.equal(M.panCC(-1), 0);
  assert.equal(M.panCC(0), 64);
  assert.equal(M.panCC(1), 127);
});

test('panCC clamps out-of-range input rather than wrapping', () => {
  assert.equal(M.panCC(-5), 0, 'far left stays far left');
  assert.equal(M.panCC(5), 127, 'far right stays far right');
});

test('panCC is symmetric about the centre', () => {
  // The same distance left and right should be the same distance from 64.
  assert.equal(64 - M.panCC(-0.5), M.panCC(0.5) - 64);
});

test('panCC treats non-numeric input as centre', () => {
  assert.equal(M.panCC(undefined), 64);
  assert.equal(M.panCC('nonsense'), 64);
});

test('describePan reads back the position, and says centre at 64', () => {
  assert.equal(M.describePan(64), 'centre');
  assert.equal(M.describePan(0), '100% left');
  assert.equal(M.describePan(127), '100% right');
  // 46 is 18 below centre out of 64 -> 28%. This number is not invented: a file
  // written with pan 46 imported into SONAR reads back as "28% 左" on the strip,
  // which is the authority for this mapping.
  assert.equal(M.describePan(46), '28% left');
  assert.equal(M.describePan(82), '29% right');
});

test('the two halves of the pan range have different widths, by design of MIDI', () => {
  // 0..64 is 64 steps, 64..127 is 63. This is not a bug to fix but a fact to
  // know: a round trip through CC10 can be off by one percent near the half
  // positions, and the extremes are still exact.
  assert.equal(M.panCC(-1), 0);
  assert.equal(M.panCC(1), 127);
  assert.equal(M.panCC(0), 64);
  assert.equal(M.describePan(M.panCC(0.5)), '51% right');
  assert.equal(M.describePan(M.panCC(-0.5)), '50% left');
});

test('midi-file and mixer agree on the pan mapping', () => {
  // Two modules implement pan conversion; a divergence would make a value
  // written by one and described by the other read wrong.
  for (const n of [-1, -0.5, 0, 0.5, 1]) {
    assert.equal(mix.panValue(n), M.panCC(n), `pan mismatch at ${n}`);
  }
  for (const v of [0, 32, 64, 96, 127]) {
    assert.equal(mix.describePan(v), M.describePan(v), `describePan mismatch at ${v}`);
  }
});

test('volumeValue maps 0..1 onto 0..127 and clamps', () => {
  assert.equal(mix.volumeValue(0), 0);
  assert.equal(mix.volumeValue(1), 127);
  assert.equal(mix.volumeValue(0.5), 64);
  assert.equal(mix.volumeValue(-1), 0);
  assert.equal(mix.volumeValue(9), 127);
});

// --- accessibility element naming -------------------------------------------

test('controlName builds the exact string SONAR exposes', () => {
  assert.equal(ui.controlName('音量', 3), '音量 on Track 3');
  assert.equal(ui.controlName('手动静音', 17), '手动静音 on Track 17');
});

test('trackNameElement builds the name element', () => {
  assert.equal(ui.trackNameElement(4), '音轨 4 on Track 4');
});

// --- coordinate conversion ---------------------------------------------------
//
// These tests used to assert the opposite of what is correct, and the mistake is
// worth keeping visible: the old boundsToClick divided bounds by the DPI scale
// because the note in track-ui.js said a click needs "frame space". That is true
// only for a computer-use raster, which is the window rescaled. UIA bounds and
// SetCursorPos are both physical screen pixels, so the click centre is the
// element centre, unchanged. Following the old rule put every click 1.5x off on
// a 150% display.

test('boundsToClick is the element centre, unchanged', () => {
  // A 42x42 element at (1034,609) centres at (1055,630) in the same space.
  assert.deepEqual(ui.boundsToClick([1034, 609, 42, 42]), [1055, 630]);
});

test('boundsToRaster divides, because a raster IS the window rescaled', () => {
  // Window 1920x902 captured as a 1280x601 raster -> scale 1.5.
  assert.deepEqual(ui.boundsToRaster([1034, 609, 42, 42], 1920, 1280), [703, 420]);
});

test('boundsToRaster is identity when the raster matches the window', () => {
  assert.deepEqual(ui.boundsToRaster([100, 200, 40, 40], 1280, 1280), [120, 220]);
});

test('boundsToClick refuses a zero-size element instead of returning nonsense', () => {
  // Elements with no geometry report [0,0,0,0]; clicking their centre would hit
  // the top-left corner of the window, so this must return null.
  assert.equal(ui.boundsToClick([0, 0, 0, 0]), null);
});

test('boundsToRaster inherits the zero-size refusal', () => {
  assert.equal(ui.boundsToRaster([0, 0, 0, 0], 1920, 1280), null);
});

test('boundsToClick returns integers', () => {
  const c = ui.boundsToClick([977, 859, 33, 33]);
  assert.ok(Number.isInteger(c[0]) && Number.isInteger(c[1]), 'clicks must be whole pixels');
});

// --- writable track controls -------------------------------------------------
//
// The three controls the adapter can write, and the state words this build uses
// for them. The words are load-bearing: setTrackControl reads the control, and
// decides from those strings whether a click is needed at all, so a wrong word
// turns an idempotent write into a spurious click.

test('WRITABLE_CONTROLS names exactly the three toggles that were proven', () => {
  assert.deepEqual(Object.keys(ui.WRITABLE_CONTROLS).sort(), ['arm', 'mute', 'solo']);
});

test('each writable control carries its own label and both state words', () => {
  for (const [key, def] of Object.entries(ui.WRITABLE_CONTROLS)) {
    assert.equal(typeof def.label, 'string', `${key} needs a label`);
    assert.ok(def.label.length > 0, `${key} label must not be empty`);
    assert.equal(def.on, '打开', `${key} on-state word`);
    assert.equal(def.off, '关闭', `${key} off-state word`);
  }
});

test('mute is 手动静音, not the automation-mute control beside it', () => {
  // There are two mute controls on a strip: 手动静音 (manual) and 自动控制的静音
  // (automation). Clicking the wrong one looks identical in the tool's output.
  assert.equal(ui.WRITABLE_CONTROLS.mute.label, '手动静音');
  assert.notEqual(ui.WRITABLE_CONTROLS.mute.label, '自动控制的静音');
});

test('controlName builds the exact element name SONAR uses', () => {
  assert.equal(ui.controlName('手动静音', 3), '手动静音 on Track 3');
  assert.equal(ui.controlName(ui.WRITABLE_CONTROLS.solo.label, 17), '独奏 on Track 17');
});

// --- plug-in format classification ------------------------------------------

test('formatOf identifies VST3, VST2 and DX paths', () => {
  assert.equal(formatOf('c:/x/Thing.vst3'), 'VST3');
  assert.equal(formatOf('c:/x/Contents/x86_64-win/Thing.vst3'), 'VST3');
  assert.equal(formatOf('d:/CAKEWALK/Boost11/Boost11_64.dll'), 'DX');
  assert.equal(formatOf('d:/CAKEWALK/Shared Plugins/compgate.dll'), 'DX');
  assert.equal(formatOf('c:/vst/SomeSynth.dll'), 'VST2');
  assert.equal(formatOf(''), undefined);
  assert.equal(formatOf(undefined), undefined);
});

// --- track templates ---------------------------------------------------------
//
// The template list comes from disk, so these assert shape and failure modes
// rather than a fixed count — the count depends on what SONAR Content is
// installed, and a test that pinned it would break on a different machine.

test('listTrackTemplates returns well-formed entries', () => {
  const all = ui.listTrackTemplates();
  assert.ok(Array.isArray(all), 'must be an array even when nothing is installed');
  for (const t of all.slice(0, 20)) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.name.length > 0, 'a template must have a name');
    assert.ok(!/\.cwx$/i.test(t.name), 'the name must not carry its extension');
    assert.equal(typeof t.file, 'string');
    assert.ok(/\.cwx$/i.test(t.file), 'file must point at a .cwx');
    assert.ok(!/[\/][^\/]*\.cwx$/i.test(t.category || ''), 'the category must not repeat the filename');
  }
});

test('findTrackTemplate names the problem for an unknown template', () => {
  assert.throws(() => ui.findTrackTemplate('definitely not a template 12345'),
    /no track template named/, 'an absent template must say so, not return undefined');
});

test('a template from the list resolves back to itself by name', () => {
  const all = ui.listTrackTemplates();
  if (!all.length) return;                       // nothing installed; nothing to check
  // Only unambiguous names can round-trip; a duplicated name is expected to
  // throw, which the previous test covers.
  const unique = all.filter((t, _, arr) => arr.filter(x => x.name === t.name).length === 1);
  if (!unique.length) return;
  const one = unique[0];
  assert.equal(ui.findTrackTemplate(one.name).file, one.file);
});

// --- audit regressions F3/F4/F5 ----------------------------------------------

test('formatSeconds rounds the WHOLE value first, so 59.9996 carries into seconds (F3)', () => {
  // The old floor-then-round split printed 0:59.1000 for 59.9996 — the
  // millisecond round overflowed without carrying. The audit's rounding
  // mutation survived the old tests; this case catches it.
  assert.equal(c.formatSeconds(59.999583), '1:00.000');
  assert.equal(c.formatSeconds(1.0006), '0:01.001');
  assert.equal(c.formatSeconds(0.5), '0:00.500');
  assert.equal(c.formatSeconds(3661.2), '1:01:01.200');
});

test('convert propagates ppq to the bar position, not just seconds (F4)', () => {
  const r = c.convert({ ticks: 3840 }, { bpm: 120, ppq: 960, timeSig: [4, 4] });
  assert.equal(r.seconds, 2, 'seconds already honoured ppq');
  assert.equal(r.time, '2:01:000', 'bar position must use the same scale');
  // Round trip through the same ppq must land back on the same tick.
  const back = c.convert({ time: r.time }, { bpm: 120, ppq: 960 });
  assert.equal(back.ticks, 3840);
  // And the default scale is unchanged.
  const d = c.convert({ ticks: 3840 }, { bpm: 120 });
  assert.equal(d.time, '3:01:000');
  const dBack = c.convert({ time: d.time }, { bpm: 120 });
  assert.equal(dBack.ticks, 3840);
});

test('transposePlan verify expectation accounts for wholeTones (F5)', () => {
  const wt = ne.transposePlan({ semitones: 2, wholeTones: true });
  assert.match(wt.verify.expect, /4 semitone/, '2 whole tones = 4 semitones');
  const st = ne.transposePlan({ semitones: 2 });
  assert.match(st.verify.expect, /2 semitone/, 'plain semitones unchanged');
});
