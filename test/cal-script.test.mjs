// test/cal-script.test.mjs — the CAL layer, process-free.
//
// What is tested here vs elsewhere. The generators produce CAL source, and the
// source is the thing that either works or silently corrupts note data, so the
// assertions below are about the SHAPE of that source: the cache block that
// must precede an insert, the NIL that must sit in the body slot, the include
// that must be present, the clamps that must be written in. None of that needs
// SONAR.
//
// What is NOT here: whether CAL actually runs, and what it does to notes. That
// was measured by hand on 2026-10-15 against an exported .mid (see the module
// header for the four results) and is recorded in the `verified:` fields, not
// re-asserted as a test — a test cannot reach SONAR from the fast tier, and
// asserting the numbers again would just be restating the docs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAL_PROGRAMS, CAL_COMMAND, RUN_CAL_DIALOG, GENERATORS,
  setVelocitySource, scaleVelocitySource, addNotesSource, deleteNotesSource,
  transposeSource, setDurationSource, queryNotesSource, dumpNotesSource,
  renameTrackSource, setTrackMuteSource, setTrackRoutingSource,
  scriptNameFor, calPlan, calHelp,
} from '../lib/cal-script.js';

// --- the record ---------------------------------------------------------------

describe('the CAL program table', () => {
  test('every program declares the metadata the invariant sweep expects', () => {
    for (const [key, p] of Object.entries(CAL_PROGRAMS)) {
      assert.ok(p.name, `${key} needs a name`);
      assert.ok(p.en, `${key} needs an English name`);
      assert.ok(p.affects, `${key} must say what it changes`);
      assert.equal(typeof p.needsSelection, 'boolean');
      assert.ok(p.sideEffect, `${key} must declare its side effect, even when it is none`);
      assert.ok(p.verified, `${key} must record how it was verified`);
    }
  });

  test('every program has a generator, so the table cannot drift from the code', () => {
    for (const key of Object.keys(CAL_PROGRAMS)) {
      assert.equal(typeof GENERATORS[key], 'function',
        `${key} is declared in CAL_PROGRAMS but has no generator`);
      assert.equal(CAL_PROGRAMS[key].op, key, `${key}: the op field must match its key`);
    }
    for (const key of Object.keys(GENERATORS)) {
      assert.ok(CAL_PROGRAMS[key], `${key} has a generator but no table entry`);
    }
  });

  test('a program claiming to be measured says MEASURED, and an unmeasured one admits it', () => {
    // The house rule: a measured claim carries its date, and an unmeasured one
    // says so rather than reading like knowledge. setDuration is the one the
    // project has NOT run, so it must not claim otherwise.
    assert.match(CAL_PROGRAMS.addNotes.verified, /MEASURED \d{4}-\d{2}-\d{2}/);
    assert.match(CAL_PROGRAMS.deleteNotes.verified, /MEASURED \d{4}-\d{2}-\d{2}/);
    assert.match(CAL_PROGRAMS.setVelocity.verified, /MEASURED \d{4}-\d{2}-\d{2}/);
    assert.match(CAL_PROGRAMS.setDuration.verified, /unverified/i);
    assert.doesNotMatch(CAL_PROGRAMS.setDuration.verified, /MEASURED/,
      'setDuration has not been run — it must not borrow the measured phrasing');
  });

  test('the command record names the dialog it opens and the licence situation', () => {
    assert.equal(CAL_COMMAND.cmdId, 0x806A);
    assert.match(CAL_COMMAND.hex, /^0x[0-9A-F]{4}$/);
    assert.ok(CAL_COMMAND.precondition);
    assert.ok(['low', 'medium', 'high', 'destructive'].includes(CAL_COMMAND.risk));
    assert.match(CAL_COMMAND.riskWhy, /undo/i,
      'undo is the only backstop for a CAL run, so the risk note must say so');
    assert.match(CAL_COMMAND.verified, /MEASURED/);
    assert.match(CAL_COMMAND.verified, /paywall/i,
      'the point of CAL is that it is NOT gated — the record must say the dialog was not the paywall');
  });

  test('the run dialog records the element that works and the ones that do not', () => {
    const f = RUN_CAL_DIALOG.fields;
    assert.equal(f.filename.kind, 'textfield');
    // The index is recorded for reference but must be flagged as unstable: it was
    // measured at 33 in one observation and 32 in the next, because a shell
    // control appears while the folder list loads. A plan that told a runtime to
    // "write element 33" would fail intermittently, which is worse than failing.
    assert.match(f.filename.warning, /MOVES|moves|unstable/i,
      'the record must say the index moves, not just that three controls share the label');
    assert.match(f.filename.warning, /set-value|set value|writab/i,
      'it must say how to find the right control instead');
    assert.equal(f.open.element, 26, 'the button held steady across observations');
    assert.equal(f.cancel.element, 25);
    assert.match(RUN_CAL_DIALOG.note, /not stable|NOT stable/i);
    assert.match(RUN_CAL_DIALOG.measured, /32/, 'the second observation is the point — record it');
  });

  test('the plan tells the runtime to resolve by property, not by index', () => {
    const p = calPlan('setVelocity', { velocity: 64 });
    const w = p.writes[0];
    assert.ok(w.resolveBy, 'a bare element index is not safe for this dialog');
    assert.match(w.resolveBy, /文件名/);
    assert.match(w.resolveBy, /set-value|set value/i);
    assert.equal(p.commit.element, 26, 'the commit button index is stable and worth stating');
  });
});

// --- generated source ---------------------------------------------------------

describe('the generated CAL source', () => {
  test('every generator emits a script that ends with a pause', () => {
    // A program with a required argument gets one supplied; everything else takes {}.
    const argsFor = {
      addNotes: { intervals: [12] },
      setTrackRouting: { channel: 1 },
      deleteNotes: { minKey: 60, maxKey: 72 },
    };
    for (const [key, gen] of Object.entries(GENERATORS)) {
      const src = gen(argsFor[key] || {});
      assert.match(src, /\(pause /, `${key}: a run with no pause gives no completion signal`);
      assert.match(src, /\(include "need20\.cal"\)/, `${key} must include the version guard`);
    }
  });

  test('the scripts that INSERT cache the event fields first', () => {
    // This is the trap the shipped HARMONYZ.CAL documents: `insert` resets the
    // in-flight event, so a field read after the first insert is not the value
    // that was there before it. The cache block is the whole reason addNotes
    // generates source rather than letting a caller write CAL by hand.
    const src = addNotesSource({ intervals: [12, 16, 19] });
    const firstInsert = src.indexOf('(insert ');
    assert.ok(firstInsert > 0, 'addNotes must insert');
    for (const field of ['(= t Event.Time)', '(= ch Event.Chan)', '(= k Note.Key)',
      '(= v Note.Vel)', '(= d Note.Dur)']) {
      const at = src.indexOf(field);
      assert.ok(at > 0, `addNotes must cache ${field}`);
      assert.ok(at < firstInsert,
        `${field} must be cached BEFORE the first insert — otherwise the later inserts land wrong`);
    }
    // …and the declarations must exist for those variables, or CAL has nothing to assign to.
    for (const decl of ['(dword t 0)', '(int ch 1)', '(int k 0)', '(int v 100)', '(dword d 240)']) {
      assert.ok(src.includes(decl), `addNotes declares ${decl}`);
    }
  });

  test('one insert per interval, at the right pitch offset', () => {
    const src = addNotesSource({ intervals: [12, 16, 19] });
    const inserts = src.match(/\(insert /g) || [];
    assert.equal(inserts.length, 3, 'three intervals means three inserts');
    assert.ok(src.includes('(+ k 12)'));
    assert.ok(src.includes('(+ k 16)'));
    assert.ok(src.includes('(+ k 19)'));
    // A negative interval adds BELOW, which is subtraction, not a negative literal.
    const down = addNotesSource({ intervals: [-12] });
    assert.ok(down.includes('(- k 12)'), 'a negative interval must become a subtraction');
  });

  test('intervals are validated rather than silently dropped', () => {
    assert.throws(() => addNotesSource({ intervals: [] }), (e) => e.code === 'NO_INTERVALS');
    assert.throws(() => addNotesSource({ intervals: [0] }), (e) => e.code === 'NO_INTERVALS',
      'a zero interval would insert a duplicate note at the same pitch — refuse it');
  });

  test('values are clamped to the ranges CAL stores', () => {
    // velocity is 1..127, keys 0..127. A generator that emitted 200 would write
    // a value the field cannot hold.
    assert.match(setVelocitySource({ velocity: 300 }), /\(int target 127\)/);
    assert.match(setVelocitySource({ velocity: 0 }), /\(int target 1\)/);
    assert.match(setVelocitySource({ velocity: 64 }), /\(int target 64\)/);
    assert.match(deleteNotesSource({ minKey: -5, maxKey: 200 }), /\(int lo 0\)[\s\S]*\(int hi 127\)/);
    // A reversed range is normalised, not emitted as an empty span.
    const rev = deleteNotesSource({ minKey: 100, maxKey: 40 });
    assert.match(rev, /\(int lo 40\)[\s\S]*\(int hi 100\)/);
  });

  test('the transpose generator handles sign and clamps the result', () => {
    assert.match(transposeSource({ semitones: 7 }), /\(= Note.Key \(\+ Note.Key 7\)\)/);
    assert.match(transposeSource({ semitones: -7 }), /\(= Note.Key \(- Note.Key 7\)\)/);
    for (const s of [transposeSource({ semitones: 7 }), transposeSource({ semitones: -7 })]) {
      assert.match(s, /\(if \(< Note.Key 0\) \(= Note.Key 0\) NIL\)/);
      assert.match(s, /\(if \(> Note.Key 127\) \(= Note.Key 127\) NIL\)/);
    }
  });

  test('duration scaling guards the 16-bit wrap', () => {
    // STRUM-IT.CAL records that durations wrap at 65535; an unclamped multiply
    // would turn a long note into a short one with no warning.
    const src = setDurationSource({ percent: 200 });
    assert.match(src, /65535/, 'the ceiling must appear in the guard');
    assert.match(src, /\(dword d 0\)/);
    assert.ok(src.indexOf('(*= d pct)') < src.indexOf('(if (> d 65535)'));
    assert.ok(src.indexOf('(if (> d 65535)') < src.indexOf('(= Note.Dur d)'));
    assert.doesNotMatch(src, /\(\*= Note.Dur/);
  });

  test('the query encodes a fixed-format summary, since it cannot return a list', () => {
    const src = queryNotesSource({ trackIndex: 0 });
    assert.match(src, /Q:n" n ",lo" lo ",hi" hi ",v" vmin "-" vmax ",d" dsum ",t" first "-" last/,
      'the format string is the parse contract — it must not drift');
    assert.match(src, /\(TrackName /, 'the track name is the only readable output channel');
    // The value must be read even when there are no notes, or the caller cannot
    // tell "empty" from "did not run".
    assert.match(src, /\(if \(== first -1\) \(= first Event.Time\) NIL\)/);
  });

  test('dumpNotes carries its own negative result in the header', () => {
    // It was measured to lose the data; the source says so, so a reader of the
    // generated file is not misled into using it as the machine-readable path.
    const src = dumpNotesSource();
    assert.match(src, /does not survive|MEASURED CAVEAT/i);
    assert.match(src, /queryNotes/, 'it must point at the channel that does work');
  });

  test('script names are stable, because a re-run must be idempotent', () => {
    assert.equal(scriptNameFor('addNotes'), 'MCP-addNotes.CAL');
    assert.equal(scriptNameFor('addNotes'), scriptNameFor('addNotes'),
      'the same op must always produce the same filename, or every run leaves a new file behind');
  });
});

describe('the track programs, whose file structure is the hard part', () => {
  // A track builtin placed at top level is read as the per-event BODY, and CAL
  // rejects it with "Error 016: invalid event information or body expression".
  // It cost two failed runs to find, so the shape is pinned here: the NIL body
  // must exist between the prolog (do ...) and the track call.
  const trackPrograms = ['renameTrack', 'setTrackMute', 'setTrackRouting'];
  const argsFor = { setTrackRouting: { channel: 1 } };

  test('each track program has a prolog (do), then a NIL body, then the track call', () => {
    for (const key of trackPrograms) {
      const src = GENERATORS[key](argsFor[key] || {});
      const prologClose = src.indexOf('\n)\nNIL\n');
      assert.ok(prologClose > 0,
        `${key}: the prolog (do) must be closed and followed by a bare NIL body — without that `
        + 'the track builtin lands in the body slot and CAL raises Error 016');
      const trackCall = src.search(/\(Track(Name|Active|Channel|Port)\b/);
      assert.ok(trackCall > prologClose,
        `${key}: the track call must come AFTER the NIL body, in the epilog slot`);
      assert.ok(src.trimEnd().endsWith(')'),
        `${key}: the file should end with the closing paren of the final (pause ...)`);
    }
  });

  test('renameTrack quotes the name and strips what would break the literal', () => {
    const src = renameTrackSource({ trackIndex: 3, name: 'MCP-VERIFY' });
    assert.match(src, /\(TrackName "MCP-VERIFY" trk\)/);
    assert.match(src, /\(int trk 3\)/);
    // CAL has no escape syntax in any shipped script, so a quote cannot be
    // escaped — it has to be dropped, or the literal terminates early.
    const nasty = renameTrackSource({ name: 'a"b\\c' });
    assert.doesNotMatch(nasty, /"a"b/);
    assert.match(nasty, /\(TrackName "abc" trk\)/);
  });

  test('setTrackMute maps the boolean the way the shipped comment defines it', () => {
    // "; Un-mute the track" sits above (TrackActive TRUE ...) in the shipped
    // script, so TRUE means audible. Getting this backwards would mute when
    // asked to un-mute, with no error.
    assert.match(setTrackMuteSource({ mute: true }), /\(TrackActive FALSE trk\)/);
    assert.match(setTrackMuteSource({ mute: false }), /\(TrackActive TRUE trk\)/);
  });

  test('setTrackRouting refuses an empty request and emits both parts when given', () => {
    assert.throws(() => setTrackRoutingSource({}), (e) => e.code === 'NOTHING_TO_SET');
    const both = setTrackRoutingSource({ trackIndex: 1, channel: 5, port: 2 });
    assert.match(both, /\(TrackChannel chan trk\)/);
    assert.match(both, /\(TrackPort port trk\)/);
    assert.match(both, /\(int chan 5\)/);
    assert.match(both, /\(int port 2\)/);
    // Channel is 1..16, not 0..15 — the dialog and CAL both count from 1 here.
    assert.match(setTrackRoutingSource({ channel: 1 }), /\(int chan 1\)/);
  });

  test('the track programs claim the right verification level', () => {
    // renameTrack was measured end to end; the other two have proven syntax but
    // no measured run. The record must not blur that — this project has been
    // burned by claims that read like knowledge.
    assert.match(CAL_PROGRAMS.renameTrack.verified, /MEASURED/);
    assert.match(CAL_PROGRAMS.setTrackMute.verified, /NOT\s+measured/i);
    assert.match(CAL_PROGRAMS.setTrackRouting.verified, /NOT measured/i);
    // …and renameTrack must record the index offset that an export reveals.
    assert.match(CAL_PROGRAMS.renameTrack.verified, /N\+1|conductor/i);
  });
});

// --- the plan -----------------------------------------------------------------

describe('calPlan', () => {
  test('it carries the source, the dialog write, and how to verify', () => {
    const p = calPlan('addNotes', { intervals: [12] });
    assert.equal(p.tool, 'cw_cal_run');
    assert.equal(p.program, 'addNotes');
    assert.ok(p.source.includes('(insert '), 'the plan must carry the exact source');
    assert.equal(p.writes.length, 1);
    assert.equal(p.writes[0].label, '文件名(N):');
    assert.equal(p.writes[0].value, 'MCP-addNotes.CAL');
    assert.match(p.writes[0].why, /ignored/, 'the write must carry the trap it avoids');
    assert.equal(p.commit.action, 'AXPress');
    assert.match(p.verify.how, /MIDI|导出/);
    assert.match(p.verify.control, /no CAL run/i);
  });

  test('it states the side effect, so a caller cannot miss the rename', () => {
    assert.match(calPlan('queryNotes', {}).sideEffect, /RENAME/i);
    assert.doesNotMatch(calPlan('setVelocity', { velocity: 64 }).sideEffect, /RENAME/i);
  });

  test('an unknown program fails with a code and lists what exists', () => {
    assert.throws(() => calPlan('dropDatabase'), (e) => {
      assert.equal(e.code, 'UNKNOWN_PROGRAM');
      assert.match(e.message, /setVelocity/);
      return true;
    });
  });
});

describe('calHelp', () => {
  test('it keeps the measured and unmeasured claims apart', () => {
    const h = calHelp();
    assert.equal(Object.keys(h.programs).length, Object.keys(CAL_PROGRAMS).length);
    assert.ok(h.traps.length >= 5, 'the traps are the expensive part of this knowledge');
    // The insert-resets-the-event trap is the one that corrupts data silently.
    assert.ok(h.traps.some((t) => /insert.*RESETS|RESETS.*insert/i.test(t)),
      'the reset trap must be in the list — it is the one that produces wrong output, not an error');
    assert.ok(h.traps.some((t) => /integer|truncat/i.test(t)));
    assert.ok(h.traps.some((t) => /65535/.test(t)));
  });

  test('it names the working read path and the one that does not work', () => {
    const h = calHelp();
    assert.match(h.readingNotes.best, /cw_read_midi_file/);
    assert.match(h.readingNotes.notWorkable, /Measured to fail|fail/i);
  });

  test('the run procedure is ordered and complete', () => {
    const h = calHelp();
    // Pin the real field name rather than tolerating an alternative. A
    // `h.runSteps || h.howToRun` here would let the field be renamed without a
    // failure, while every caller broke — the same "test that cannot fail"
    // shape this project has been bitten by before.
    const steps = h.howToRun;
    assert.ok(Array.isArray(steps), 'calHelp must expose howToRun');
    assert.ok(steps.length >= 6);
    assert.deepEqual(steps.map((s) => s.step), steps.map((_, i) => i + 1),
      'the steps must be numbered without gaps');
    assert.match(JSON.stringify(steps), /0x806A/, 'the command id must appear');
    assert.match(JSON.stringify(steps), /pause/i, 'dismissing the pause must be a step');
  });

  test('the addNotes prolog declares every int indented — SONAR rejects a bare one', () => {
    // Real host (SONAR2026.10) observation only: a generated addNotes whose
    // (int p 0) sat at column 0 immediately after (int n 0) failed with
    // CAL Error003 "int". Reindenting that one line to two spaces — no variable
    // renames — made the same script succeed, adding 2 notes to each of 6
    // source notes. Renaming without fixing the indentation still failed. So
    // the indentation is what the host parser needed here; retesting on the
    // actual host remains a separate step from this unit test.
    const src = addNotesSource({ intervals: [127, -127] });
    const prolog = src.slice(0, src.indexOf('\n(if'));
    assert.match(prolog, /\n  \(int p 0\)\n/);
    assert.doesNotMatch(prolog, /^\(int /m);
  });

  test('it admits what the layer cannot do', () => {
    const h = calHelp();
    assert.ok(h.limits.length >= 3);
    assert.ok(h.limits.some((l) => /selection/i.test(l)),
      'CAL acts on the selection — it cannot address a note by index');
    assert.ok(h.limits.some((l) => /pause|export/i.test(l)),
      'the reporting limit must be stated');
  });
});
