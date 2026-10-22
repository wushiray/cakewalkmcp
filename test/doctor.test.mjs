// test/doctor.test.mjs — the verdict rules behind cw_doctor.
//
// Why this file exists: the doctor's channel classifiers had NO test coverage,
// and three separate defects lived exactly there, each one found by an outside
// tester rather than by the suite:
//
//   * t4 asked only "can a MIDI out port be opened" and answered pass / fix:
//     nothing — while SONAR had no matching input enabled and dropped every
//     message. A whole channel was reported healthy while being unusable.
//   * t3's fix text told the reader to install a control surface the installer
//     now deliberately skips, so a healthy machine read as broken.
//   * the t5 upgrade hint pointed at the label tables whenever t5 was not pass,
//     including when the only problem was "no project open" — contradicting the
//     channel's own fix field in the same reply.
//
// The classifiers were extracted from the probe functions so these rules can be
// asserted directly, with no SONAR, no plugin and no MIDI device present.

import test from 'node:test';
import assert from 'node:assert/strict';

import { midiChannel, surfaceChannel, cakescriptChannel, upgradeHints } from '../lib/doctor.js';

// --- t4: three states, not two ----------------------------------------------

test('t4: no usable port reports unavailable and names loopMIDI', () => {
  // `available: true` because ordinary hardware ports exist — this is exactly the
  // shape that used to pass: Windows always has *some* MIDI out device, so
  // "available" says nothing about whether the adapter has a cable.
  const r = midiChannel({
    available: true,
    selected: null,
    sonarReceives: false,
    ports: { out: ['Microsoft GS Wavetable Synth'], in: [] },
    setup: 'No loopMIDI output port available. Start loopMIDI and create a port.',
  });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.fix, /loopMIDI/i);
});

test('t4: a port with no matching SONAR input reports degraded, not pass', () => {
  const setup = 'SONAR does not have "Studio One AI Notes" enabled as a MIDI input.';
  const r = midiChannel({
    available: true,
    selected: 'Studio One AI Notes',
    sonarReceives: false,
    ports: { out: ['Studio One AI Notes'], in: ['Studio One AI Notes'] },
    setup,
  });
  // The defect this pins: every message is accepted by the driver and dropped.
  // Reporting "pass / nothing to do" here is what made an outside tester call the
  // channel "pass, but there is a catch".
  assert.equal(r.verdict, 'degraded');
  assert.equal(r.fix, setup);
});

test('t4: port present and SONAR listening reports pass, with the routing caveat', () => {
  const r = midiChannel({
    available: true,
    selected: 'Studio One AI Notes',
    sonarReceives: true,
    ports: { out: ['Studio One AI Notes'], in: ['Studio One AI Notes'] },
    setup: 'Ready: SONAR has the port enabled.',
  });
  assert.equal(r.verdict, 'pass');
  // Enabled is not routed: a message still needs an armed track / ACT binding.
  assert.match(r.fix, /destination|arm|ACT/i);
});

test('t4: a completely absent MIDI subsystem is unavailable, never a crash', () => {
  const r = midiChannel({ available: false, selected: null, sonarReceives: false, ports: { out: [], in: [] } });
  assert.equal(r.verdict, 'unavailable');
});

// --- t3: the surface is opt-in ----------------------------------------------

test('t3: not installed is described as the default, not as breakage', () => {
  const r = surfaceChannel({ bridge_reachable: false, connected: false, state: 'not-installed' });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.fix, /DEFAULT/);
  assert.match(r.fix, /no capability needs it/i);
  assert.match(r.fix, /-WithSurface/);
  // The old text said "run the install step (regsvr32 …)", which contradicts the
  // installer that now skips this component on purpose.
  assert.doesNotMatch(r.fix, /run the install step/i);
});

test('t3: loaded but not connected explains the per-launch manual step', () => {
  const r = surfaceChannel({ bridge_reachable: true, connected: false });
  assert.equal(r.verdict, 'degraded');
  assert.match(r.fix, /Connect\(\)|控制界面/);
  assert.match(r.fix, /opt-in|unnecessary/i);
});

test('t3: connected reports pass without telling anyone to install anything', () => {
  const r = surfaceChannel({ bridge_reachable: true, connected: true });
  assert.equal(r.verdict, 'pass');
  assert.match(r.fix, /nothing/i);
});

// --- t1: name the tools that do NOT fall back -------------------------------

test('t1: unavailable names both the falling-back and the non-falling-back tools', () => {
  const r = cakescriptChannel({ transports: { cakescript: { available: false, detail: 'absent' } } });
  assert.equal(r.verdict, 'unavailable');
  // Falls back:
  assert.match(r.fix, /cw_set_track_mute/);
  assert.match(r.fix, /cw_transport/);
  assert.match(r.fix, /cw_set_track_name/);
  // Does NOT fall back — the old text claimed every affected tool fell back,
  // which sent callers retrying variations of a call that can never work.
  assert.match(r.fix, /do NOT/);
  assert.match(r.fix, /cw_list_tracks/);
  assert.match(r.fix, /cw_locate/);
});

test('t1: detecting an Assistant cannot report working IPC', () => {
  const r = cakescriptChannel({ transports: { cakescript: { available: true, detail: 'ok' } } });
  assert.equal(r.verdict, 'degraded');
  assert.equal(r.detail.available, false);
  assert.equal(r.detail.state, 'detected-not-implemented');
  assert.match(r.fix, /not implemented/);
});

// --- upgrade hints: only when the cause could be label drift ----------------

const ch = (probe, verdict, detail = {}) => ({ probe, verdict, detail });

test('t5 hint stays quiet when the real cause is "no project open"', () => {
  const hints = upgradeHints([
    ch('t5-uia-click', 'degraded', { document: { known: true, projectOpen: false } }),
  ], {});
  // Pointing at the label tables here contradicts the channel's own fix field
  // ("open a project") in the same reply — the exact contradiction an outside
  // tester reported against the wrong field.
  assert.equal(hints.length, 0);
});

test('t5 hint appears once tracks exist, because then label drift is plausible', () => {
  const hints = upgradeHints([
    ch('t5-uia-click', 'degraded', { visibleTracks: [1, 2] }),
  ], {});
  assert.equal(hints.length, 1);
  assert.match(hints[0], /WRITABLE_CONTROLS/);
});

test('t3 degraded hint says the surface is opt-in, not that something regressed', () => {
  const hints = upgradeHints([ch('t3-surface', 'degraded', {})], {});
  assert.equal(hints.length, 1);
  assert.match(hints[0], /opt-in/i);
  assert.match(hints[0], /Ignore unless/i);
  assert.doesNotMatch(hints[0], /not a regression/);
});

test('no hints at all when every channel passes', () => {
  const hints = upgradeHints([
    ch('t1-cakescript', 'pass'), ch('t2-wm-command', 'pass'),
    ch('t3-surface', 'pass'), ch('t5-uia-click', 'pass'),
  ], {});
  assert.deepEqual(hints, []);
});
