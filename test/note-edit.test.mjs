// test/note-edit.test.mjs — note-level editing, and the measurement discipline
// that produced it.
//
// Two kinds of test here, and the distinction matters.
//
// The first kind pins pure arithmetic: snapping, prediction, the grid table.
// Those are cheap and they must never drift.
//
// The second kind pins RECORDED MEASUREMENTS from a real session against a real
// SONAR. The eight ticks below are not invented — they were written into a .mid
// deliberately off-grid, imported, quantized through the dialog, exported, and
// parsed back. Freezing those numbers here means that if the model of how
// quantize behaves is ever changed, the change has to be argued against a
// real observation rather than a plausible one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapToGrid, gridTicks, predictQuantize, judgeQuantize, NOTE_VALUE_TICKS,
  QUANTIZE_DIALOG, quantizePlan, transposePlan, noteEditHelp,
} from '../lib/note-edit.js';

// The measured run. Source ticks were placed 30/50/-25/37/-43/61/-18/44 off the
// 480-tick bar grid, then sorted.
const SOURCE = [30, 530, 935, 1477, 1877, 2461, 2862, 3404];
const RESULT_100 = [0, 480, 960, 1440, 1920, 2520, 2880, 3360];
const RESULT_50 = [16, 506, 948, 1460, 1899, 2432, 2872, 3383];
const CONTROL = [30, 530, 935, 1477, 1877, 2461, 2862, 3404];
const GRID_16 = 120;

describe('snapToGrid', () => {
  test('moves a tick to the nearest grid line', () => {
    assert.equal(snapToGrid(30, 120), 0);
    assert.equal(snapToGrid(61, 120), 120);
    assert.equal(snapToGrid(530, 120), 480);
    assert.equal(snapToGrid(935, 120), 960);
  });

  test('a tick already on the grid does not move', () => {
    for (const t of RESULT_100) assert.equal(snapToGrid(t, 120), t);
  });

  test('never returns a negative tick', () => {
    assert.equal(snapToGrid(-40, 120), 0);
    assert.equal(snapToGrid(0, 120), 0);
  });

  test('a half-way tick rounds up, deterministically', () => {
    // 60 is exactly between 0 and 120. Math.round takes it up; pinning this
    // keeps the prediction reproducible rather than merely plausible.
    assert.equal(snapToGrid(60, 120), 120);
  });

  test('a grid of 1 is the identity', () => {
    for (const t of SOURCE) assert.equal(snapToGrid(t, 1), t);
  });
});

describe('gridTicks', () => {
  test('the measured grid, 16 分音符, is 120 ticks at 480 PPQ', () => {
    assert.equal(gridTicks('16 分音符'), 120);
  });

  test('musical note values resolve, in both spellings', () => {
    assert.equal(gridTicks('quarter'), 480);
    assert.equal(gridTicks('4 分音符'), 480);
    assert.equal(gridTicks('8 分音符'), 240);
    assert.equal(gridTicks('32 分音符'), 60);
    assert.equal(gridTicks('whole'), 1920);
    assert.equal(gridTicks('1/16'), 120);
  });

  test('an unknown value returns null rather than guessing', () => {
    assert.equal(gridTicks('triplet'), null);
    assert.equal(gridTicks(''), null);
    assert.equal(gridTicks('16th note'), null);
  });

  test('PPQ is honoured', () => {
    assert.equal(gridTicks('4 分音符', 960), 960);
    assert.equal(gridTicks('16 分音符', 960), 240);
  });

  test('every entry in the table is a positive number of beats', () => {
    for (const [k, v] of Object.entries(NOTE_VALUE_TICKS)) {
      assert.ok(v > 0 && v <= 4, `${k} = ${v} is not a sane beat fraction`);
    }
  });
});

describe('predictQuantize — the measured run', () => {
  test('at full strength it reproduces the exported result exactly', () => {
    // This is the load-bearing test. The prediction was written from the
    // arithmetic; the expectation came from SONAR. They agree on all 8 notes.
    assert.deepEqual(predictQuantize(SOURCE, GRID_16, 100), RESULT_100);
  });

  test('at full strength every predicted note lands on the grid', () => {
    for (const t of predictQuantize(SOURCE, GRID_16, 100)) {
      assert.equal(t % GRID_16, 0, `${t} is not on the 16th grid`);
    }
  });

  test('a half-strength result does NOT land on the grid — the shape of the trap', () => {
    // This is why a default 50% strength looks like a failure: the notes move
    // but stay off-grid, so nothing about the result says "quantize worked".
    const half = predictQuantize(SOURCE, GRID_16, 50);
    const onGrid = half.filter((t) => t % GRID_16 === 0);
    assert.equal(onGrid.length, 0, 'a half-strength quantize should not reach the grid');
  });

  test('zero strength changes nothing', () => {
    assert.deepEqual(predictQuantize(SOURCE, GRID_16, 0), SOURCE);
  });

  test('strength is clamped to 0-100', () => {
    assert.deepEqual(predictQuantize(SOURCE, GRID_16, 250), predictQuantize(SOURCE, GRID_16, 100));
    assert.deepEqual(predictQuantize(SOURCE, GRID_16, -5), SOURCE);
  });

  test('the output length always matches the input length', () => {
    for (const s of [0, 25, 50, 75, 100]) {
      assert.equal(predictQuantize(SOURCE, GRID_16, s).length, SOURCE.length);
    }
  });
});

describe('judgeQuantize — reading a real result', () => {
  test('the full-strength run is judged as quantized', () => {
    const v = judgeQuantize({ before: SOURCE, after: RESULT_100, grid: GRID_16, strength: 100 });
    assert.equal(v.changed, true);
    assert.equal(v.allOnGrid, true);
    assert.equal(v.matchedPrediction, true);
    assert.match(v.verdict, /quantized/);
  });

  test('the control export is reported as no movement, with the right conclusion', () => {
    // The control is the same file exported with no edit — so nothing moved, which
    // is exactly what a no-op export should show. What matters is that the verdict
    // says NOTHING MOVED rather than blaming the dialog settings, and that the tick
    // comparison reports no change. (The audit's rewrite made this distinction
    // explicit: "no movement" and "moved but off-grid" used to give similar prose.)
    const v = judgeQuantize({ before: SOURCE, after: CONTROL, grid: GRID_16, strength: 100 });
    assert.equal(v.changed, false);
    assert.equal(v.countChanged, false);
    assert.equal(v.matchedPrediction, false);
    assert.match(v.verdict, /nothing moved/);
    assert.doesNotMatch(v.verdict, /different settings/,
      'a control export must not be explained as a settings mismatch');
  });

  test('a half-strength run is not called a failure', () => {
    const v = judgeQuantize({ before: SOURCE, after: RESULT_50, grid: GRID_16, strength: 100 });
    assert.equal(v.allOnGrid, false);
    // Judged against the wrong strength it cannot match, but the wording must
    // not assert that the command failed — the notes demonstrably moved.
    assert.equal(v.changed, true);
  });

  test('prediction confidence is exact only at full strength', () => {
    const full = judgeQuantize({ before: SOURCE, after: RESULT_100, grid: GRID_16, strength: 100 });
    const half = judgeQuantize({ before: SOURCE, after: RESULT_50, grid: GRID_16, strength: 50 });
    assert.match(full.predictionConfidence, /exact/);
    assert.match(half.predictionConfidence, /approximate/);
  });

  test('the partial-strength caveat names how close it actually got', () => {
    // The wording must not overstate the failure OR the fit. Measured: 7 of 8
    // notes within a tick, one 59 ticks out. Saying only "up to 59 off" reads as
    // "the model is wrong"; saying nothing reads as "it works". Both facts belong.
    const half = judgeQuantize({ before: SOURCE, after: RESULT_50, grid: GRID_16, strength: 50 });
    assert.match(half.predictionConfidence, /7 of 8/, 'the fit must be stated, not just the miss');
    assert.match(half.predictionConfidence, /59/, 'and the outlier, with its magnitude');
    assert.match(half.predictionConfidence, /2461|2432|2491/, 'pinned to the actual tick values');
  });

  test('the half-strength outlier is exactly one note, not a general error', () => {
    // Freezes the measurement: if the model is ever changed, this says which note
    // disagreed and by how much, so the change has to argue with the data.
    const predicted = predictQuantize(SOURCE, GRID_16, 50);
    const diffs = RESULT_50.map((t, i) => Math.abs(t - (predicted[i] ?? 0)));
    const outliers = diffs.filter((d) => d > 2);
    assert.equal(outliers.length, 1, 'exactly one note should be far off the linear model');
    assert.equal(outliers[0], 59, 'and by 59 ticks');
    assert.equal(diffs.filter((d) => d <= 1).length, 7, 'the other seven are rounding-level');
  });

  test('a result that drifted everywhere is reported honestly', () => {
    const v = judgeQuantize({
      before: SOURCE, after: SOURCE.map((t) => t + 7), grid: GRID_16, strength: 100,
    });
    assert.equal(v.allOnGrid, false);
    assert.equal(v.matchedPrediction, false);
    assert.match(v.verdict, /do not match/);
  });

  test('every judgement carries the control instruction', () => {
    const v = judgeQuantize({ before: SOURCE, after: RESULT_100, grid: GRID_16 });
    assert.match(v.controlNote, /export it with\s+no edit/i);
  });
});

/*
 * The two holes an adversarial audit found in this function, from two directions.
 * The verdict branched only on matchedPrediction/allOnGrid, so it could not tell
 * "a fractional strength legitimately moved nothing" from "the commit never
 * applied", and it explained a changed note count as a settings mismatch.
 */
describe('judgeQuantize — telling failure apart from success', () => {
  test('nothing moved at strength 0 is a legitimate no-op, and says so', () => {
    const v = judgeQuantize({ before: [100, 530, 935], after: [100, 530, 935], grid: 120, strength: 0 });
    assert.equal(v.changed, false);
    assert.match(v.verdict, /strength 0 means no change is the correct/,
      'a zero-strength quantize is SUPPOSED to do nothing — that is not a failure');
    assert.doesNotMatch(v.verdict, /most likely did not apply/,
      'and it must not be reported as a failed commit');
  });

  /*
   * The third cause, found by attacking this function rather than by writing it.
   * "Nothing moved" has two innocent explanations, and the first version of this
   * check only recognised one of them.
   */
  test('notes already on the grid are a SUCCESS, not a suspected failure', () => {
    const v = judgeQuantize({ before: [0, 120, 240], after: [0, 120, 240], grid: 120, strength: 100 });
    assert.equal(v.changed, false);
    assert.match(v.verdict, /nothing needed to/,
      'a source already on the grid needs no change — reporting "did not apply" turns a working '
      + 'run into a suspected failure');
    assert.match(v.verdict, /SUCCESS/);
    assert.doesNotMatch(v.verdict, /did not apply/);
  });

  test('a real no-op failure is still reported as one', () => {
    // The distinction that must survive: off-grid notes, real strength, no movement.
    const v = judgeQuantize({ before: [100, 530], after: [100, 530], grid: 120, strength: 100 });
    assert.match(v.verdict, /most likely did not apply/);
    assert.match(v.verdict, /NOT a quantize result/);
    assert.doesNotMatch(v.verdict, /SUCCESS/);
  });

  test('nothing moved at full strength is reported as the commit not applying', () => {
    const v = judgeQuantize({ before: [100, 530, 935], after: [100, 530, 935], grid: 120, strength: 100 });
    assert.equal(v.changed, false);
    assert.match(v.verdict, /most likely did not apply/);
  });

  test('a fractional strength that moved something is still not called a failure', () => {
    const v = judgeQuantize({ before: SOURCE, after: RESULT_50, grid: GRID_16, strength: 100 });
    assert.equal(v.changed, true);
    assert.doesNotMatch(v.verdict, /do not match the prediction and are not on the grid.*did not apply/s);
  });

  test('a changed note count is reported as a count change, not as a settings mismatch', () => {
    // A note dropped during the edit or export. The old verdict blamed the dialog
    // settings, which would send a user to re-open the dialog instead of looking
    // for the missing note.
    const v = judgeQuantize({ before: [0, 480, 960], after: [0, 960], grid: 480, strength: 100 });
    assert.equal(v.countChanged, true);
    assert.match(v.verdict, /note count changed/);
    assert.match(v.verdict, /3 before, 2 after/, 'it must name both counts');
    assert.doesNotMatch(v.verdict, /different settings/,
      'a missing note must not be explained as a settings difference');
  });

  /*
   * A count change must not swallow the news that the quantize worked. Found by a
   * verifier: the count branch fires before any position comparison, so a
   * legitimate count change (SONAR merging same-pitch overlaps on export) reported
   * "not a quantize result" while every surviving note sat exactly on the grid.
   */
  test('a count change plus an on-grid result reports BOTH facts', () => {
    const v = judgeQuantize({ before: [30, 150, 270], after: [0, 120, 240, 360], grid: 120, strength: 100 });
    assert.equal(v.countChanged, true);
    assert.equal(v.allOnGrid, true);
    assert.match(v.verdict, /note count changed/, 'the count change is still the headline');
    assert.match(v.verdict, /landed on the grid/, 'but the quantize success must be visible');
    assert.match(v.verdict, /worked/, 'and stated as a success, not implied away');
  });

  /*
   * An EMPTY after[] is the audit's F2: `[].every()` is vacuously true, so the
   * old code said "the quantize itself worked" while the count said every note
   * vanished. With no survivors there is no position evidence — allOnGrid must
   * be false and the verdict must say UNCONFIRMED, never "worked".
   */
  test('an empty result is unconfirmed, not a success (F2)', () => {
    const v = judgeQuantize({ before: [30, 530], after: [], grid: 120, strength: 100 });
    assert.equal(v.countChanged, true);
    assert.equal(v.allOnGrid, false, 'an empty result carries no grid evidence');
    assert.equal(v.quantizeProven, false);
    assert.match(v.verdict, /UNCONFIRMED/, 'the verdict must not claim success');
    assert.doesNotMatch(v.verdict, /quantize itself worked/);
  });

  test('a count change with off-grid survivors stays inconclusive', () => {
    const v = judgeQuantize({ before: [30, 150, 270], after: [7, 133, 240, 360], grid: 120, strength: 100 });
    assert.equal(v.countChanged, true);
    assert.equal(v.allOnGrid, false);
    assert.match(v.verdict, /inconclusive/,
      'with neither a clean count nor a clean grid, the honest answer is neither verdict');
  });

  test('a note added is caught the same way', () => {
    const v = judgeQuantize({ before: [0, 480, 960], after: [0, 480, 480, 960], grid: 480, strength: 100 });
    assert.equal(v.countChanged, true);
    assert.match(v.verdict, /4 after/);
  });

  test('changed is true when the count changed even if the survivors are identical', () => {
    const v = judgeQuantize({ before: [0, 960], after: [0, 960, 0], grid: 480, strength: 100 });
    assert.equal(v.changed, true, 'a count change is a change regardless of positions');
  });
});

describe('judgeQuantize — a malformed strength is refused, not silently obeyed', () => {
  test('a non-finite strength falls back and says so', () => {
    const v = judgeQuantize({ before: [100, 530], after: [120, 480], grid: 120, strength: NaN });
    assert.equal(v.strengthInvalid, true);
    assert.equal(v.strengthUsed, 100, 'it falls back to the honest default');
    assert.match(v.strengthWarning, /not a finite number/);
  });

  /*
   * `Number(true)` is 1 and `Number(null)` is 0. A bare Number() coercion therefore
   * accepted a boolean as a 1% strength and null as a 0% one — both silently, both
   * reported as valid. Found by attacking the function with a type it never
   * expected; only a number or a numeric string is a strength.
   */
  test('a boolean is not a strength', () => {
    for (const bad of [true, false, null, [], {}]) {
      const v = judgeQuantize({ before: [100, 530], after: [120, 480], grid: 120, strength: bad });
      assert.equal(v.strengthInvalid, true,
        `strength ${JSON.stringify(bad)} must be refused, not coerced`);
      assert.equal(v.strengthUsed, 100);
    }
  });

  test('predictQuantize refuses boolean and null the same way', () => {
    const full = predictQuantize([100, 530], GRID_16, 100);
    for (const bad of [true, false, null]) {
      assert.deepEqual(predictQuantize([100, 530], GRID_16, bad), full,
        `${String(bad)} must fall back to full strength, not to 1% or 0%`);
    }
  });

  test('a non-numeric string is coerced, not propagated as NaN', () => {
    const v = judgeQuantize({ before: [100, 530], after: [120, 480], grid: 120, strength: 'abc' });
    assert.equal(v.strengthInvalid, true);
    assert.ok(v.predicted.every((t) => Number.isFinite(t)), 'predictions must never be NaN');
  });

  test('a numeric string is accepted and produces no warning', () => {
    const v = judgeQuantize({ before: SOURCE, after: RESULT_50, grid: GRID_16, strength: '50' });
    assert.equal(v.strengthInvalid, false);
    assert.equal(v.strengthUsed, 50);
    assert.equal(v.strengthWarning, undefined);
  });

  test('a whitespace-padded numeric string is still numeric', () => {
    const v = judgeQuantize({ before: SOURCE, after: RESULT_50, grid: GRID_16, strength: ' 50 ' });
    assert.equal(v.strengthInvalid, false);
    assert.equal(v.strengthUsed, 50);
  });

  test('predictQuantize itself never returns NaN for a bad strength', () => {
    for (const bad of [NaN, 'abc', undefined, null, Infinity, -Infinity, true]) {
      const out = predictQuantize([100, 530, 935], GRID_16, bad);
      assert.ok(out.every((t) => Number.isFinite(t)), `strength ${String(bad)} produced NaN`);
    }
  });

  /*
   * An out-of-range strength was silently clamped: 150 became 100 and -10 became 0,
   * both reported as valid with no warning. A verifier found it. The value used was
   * not the value supplied, and that is exactly what the caller must be told —
   * same class of defect as a fabricated witness.
   */
  test('a strength outside 0-100 is clamped and SAYS it was clamped', () => {
    const high = judgeQuantize({ before: [100, 530], after: [120, 480], grid: 120, strength: 150 });
    assert.equal(high.strengthUsed, 100);
    assert.equal(high.strengthOutOfRange, true);
    assert.equal(high.strengthAdjusted, true);
    assert.match(high.strengthWarning, /outside 0-100/);
    assert.match(high.strengthWarning, /clamped to 100/);

    const low = judgeQuantize({ before: [100, 530], after: [120, 480], grid: 120, strength: -10 });
    assert.equal(low.strengthUsed, 0);
    assert.match(low.strengthWarning, /clamped to 0/);
  });

  test('an in-range strength is not reported as adjusted', () => {
    for (const good of [0, 50, 100, '50']) {
      const v = judgeQuantize({ before: SOURCE, after: RESULT_50, grid: GRID_16, strength: good });
      assert.equal(v.strengthAdjusted, false, `strength ${good} should need no adjustment`);
      assert.equal(v.strengthWarning, undefined);
    }
  });

  test('every adjusted strength carries a warning, and every warning an adjustment', () => {
    // The field and the message must not be able to disagree — a caller filtering
    // on the boolean would otherwise miss a reason, or chase one that is absent.
    for (const s of [150, -10, 50, 100, 'abc', null, true, NaN]) {
      const v = judgeQuantize({ before: [100, 530], after: [120, 480], grid: 120, strength: s });
      assert.equal(v.strengthAdjusted, Boolean(v.strengthWarning),
        `strength ${String(s)}: adjusted=${v.strengthAdjusted} but warning=${Boolean(v.strengthWarning)}`);
    }
  });
});

describe('QUANTIZE_DIALOG — the recorded measurement', () => {
  test('the duration field warns about the same-labelled combobox', () => {
    // 时值(U): exists as both a combobox and a textfield. Writing the combobox is
    // accepted and ignored, which is a silent failure worth pinning.
    assert.equal(QUANTIZE_DIALOG.fields.duration.kind, 'textfield');
    assert.match(QUANTIZE_DIALOG.fields.duration.warning, /combobox/);
  });

  test('the strength field records that it persists between invocations', () => {
    assert.match(QUANTIZE_DIALOG.fields.strength.warning, /persist/i);
    assert.match(QUANTIZE_DIALOG.fields.strength.warning, /half|50/);
  });

  test('every field names the element kind to write to', () => {
    for (const [name, f] of Object.entries(QUANTIZE_DIALOG.fields)) {
      assert.equal(f.kind, 'textfield', `${name} should be a textfield`);
      assert.ok(typeof f.label === 'string' && f.label.length, `${name} has no label`);
    }
  });

  test('the checkbox caveat is recorded, not glossed over', () => {
    assert.match(QUANTIZE_DIALOG.checkboxCaveat, /screenshot/);
  });

  test('the five fields the plan writes are exactly the dialog fields', () => {
    const planned = new Set(['duration', 'strength', 'sensitivity', 'swing', 'offset']);
    for (const k of planned) assert.ok(QUANTIZE_DIALOG.fields[k], `missing field ${k}`);
  });
});

describe('quantizePlan', () => {
  test('writes every field explicitly, so no stale default can explain a result', () => {
    const p = quantizePlan({ grid: '16 分音符', strength: 100 });
    const names = p.writes.map((w) => w.field).sort();
    assert.deepEqual(names, ['duration', 'offset', 'sensitivity', 'strength', 'swing']);
  });

  test('the strength write carries the warning that produced the wrong conclusion', () => {
    const p = quantizePlan({ strength: 100 });
    const s = p.writes.find((w) => w.field === 'strength');
    assert.match(s.why, /persist|stale/i);
  });

  test('it names the asynchronous-close trap', () => {
    assert.match(quantizePlan().afterCommit, /asynchronous/);
  });

  test('it says how to verify, and that a control is required', () => {
    const p = quantizePlan();
    assert.match(p.verify.how, /导出|MIDI/);
    assert.match(p.verify.control, /no edit|SAME file/i);
  });

  test('the plan reflects the caller settings', () => {
    const p = quantizePlan({ grid: '8 分音符', strength: 75, swing: 60, offset: 4 });
    const val = (f) => p.writes.find((w) => w.field === f).value;
    assert.equal(val('duration'), '8 分音符');
    assert.equal(val('strength'), '75');
    assert.equal(val('swing'), '60');
    assert.equal(val('offset'), '4');
  });
});

describe('transposePlan', () => {
  test('it writes the measured 数量 field, with the sign preserved', () => {
    const down = transposePlan({ semitones: -5 });
    const w = down.writes.find((x) => x.field === 'amount');
    assert.equal(w.value, '-5', 'a negative interval must survive into the plan — transposing '
      + 'down is half the use of this dialog');
    assert.equal(w.kind, 'textfield');
    assert.equal(w.label, '数量(A):');
    assert.match(w.why, /signed/i);
  });

  test('whole tones is a separate write, and absent unless asked for', () => {
    assert.equal(transposePlan().writes.length, 1, 'by default only the interval is written');
    const wt = transposePlan({ semitones: 2, wholeTones: true });
    assert.equal(wt.writes.length, 2);
    assert.ok(wt.writes.some((w) => w.field === 'wholeTone'));
  });

  test('it names the controls that must NOT be touched', () => {
    const p = transposePlan({ semitones: 1 });
    const names = p.doNotTouch.map((d) => d.field).sort();
    assert.deepEqual(names, ['algorithm', 'audioTranspose'],
      'ticking 音频移调 hands the job to the Elastic engine — the plan must say not to');
  });

  test('it states the expected per-note shift, so a verify has something to check against', () => {
    assert.match(transposePlan({ semitones: 3 }).verify.expect, /3 semitone/);
  });

  test('it names the asynchronous-close trap and the no-edit control, like quantize', () => {
    const p = transposePlan();
    assert.match(p.afterCommit, /asynchronous/);
    assert.match(p.verify.control, /no edit/i);
  });
});

describe('noteEditHelp — the recorded knowledge', () => {
  test('the chain has all six steps in order', () => {
    const h = noteEditHelp();
    assert.equal(h.chain.length, 6);
    assert.deepEqual(h.chain.map((s) => s.step), [1, 2, 3, 4, 5, 6]);
  });

  test('the verification step is the export', () => {
    const h = noteEditHelp();
    const exportStep = h.chain.find((s) => s.step === 5);
    assert.equal(exportStep.cmdId, 0xA659);
  });

  test('both measurement mistakes are recorded', () => {
    const h = noteEditHelp();
    assert.equal(h.mistakesRecorded.length, 2);
    assert.ok(h.mistakesRecorded.some((m) => /asynchronous|too soon|window list/i.test(m)));
    assert.ok(h.mistakesRecorded.some((m) => /control/i.test(m)));
  });

  test('it does not claim reading works — that limit is stated', () => {
    const h = noteEditHelp();
    assert.ok(h.limits.some((l) => /Reading notes still has no surface/.test(l)));
  });

  test('the verified numbers match the constants this file pins', () => {
    const h = noteEditHelp();
    for (const t of RESULT_100) assert.match(h.verified.quantize, new RegExp(String(t)));
  });

  test('it admits that only 量化 and 移调 were measured field by field', () => {
    const h = noteEditHelp();
    // The limit must keep saying WHICH dialogs are measured, and that the rest of
    // the 处理 menu is not — a claim of "the dialogs are measured" without the
    // qualifier would overstate what was done. It must also name where the
    // unmeasured ones are recorded, so the gap is actionable rather than a dead end.
    assert.ok(
      h.limits.some((l) => /量化 and 移调 are measured field by field/.test(l)),
      'the limit must name both measured dialogs'
    );
    assert.ok(
      h.limits.some((l) => /EDIT_COMMANDS in edit\.js/.test(l)),
      'the unmeasured commands must point at where they are listed'
    );
    assert.ok(h.dialogs.transpose.verified, 'the transpose dialog must carry its verification note');
    assert.equal(h.dialogs.transpose.fields.amount.element, 25,
      'the measured element index for 数量(A) must not drift');
  });
});
