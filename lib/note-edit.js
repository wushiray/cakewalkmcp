// lib/note-edit.js — editing notes, and proving the edit landed.
//
// This module closes the gap the README used to describe as unclosable. The
// earlier note read: "note-level data has no accessibility surface, so a .mid
// file is the only way notes cross the boundary." That is true for READING and
// it was wrongly extended to WRITING. Reading really has no surface. Writing
// does, and it is the dialog behind the edit command.
//
// The chain, every link measured on 32.10.0.021:
//
//   1. 编辑 > 选择 > 全部            (0x804C)   gives the edit something to act on
//   2. 处理 > 量化                   (0x8061)   opens a standard MFC #32770「量化」
//   3. AXSetValue on the dialog's fields         writes land; read back and confirmed
//   4. AXPress 确定                              commits and the dialog closes
//   5. 文件 > 导出 > 标准 MIDI 文件   (0xA659)   writes the result to disk
//   6. lib/midi-file.js read()                    proves what changed, in ticks
//
// Step 5 is what makes this honest. Nothing in the UI reports note times, so a
// commit that silently did nothing looks exactly like one that worked. Exporting
// and parsing the file is the only witness, and the adapter already has both
// halves of it.
//
// Two measurement mistakes are recorded here because they cost real time and
// both would have produced a wrong answer.
//
// MISTAKE 1 — reading the window list too soon. AXPress is accepted, the action
// happens, and the dialog closes asynchronously. Checking the window list
// immediately after shows the dialog still open, and the natural reading is
// "the press did nothing". It did; the check was early. Wait, then look.
//
// MISTAKE 2 — no control group. The first quantize ran at the dialog's default
// 50% strength, which moves each note HALF way to the grid. Those ticks were
// ~10-30 off, moving in mixed directions, and looked like export rounding noise.
// The fix was to import the same file and export it again with no edit at all:
// that control showed zero drift, which proved the movement was real and that
// the cause had to be the strength setting. Without the control, "quantize is
// broken" would have been written down as a finding.

import { call } from '../bridge/agent.js';
import { runCommand } from './menu.js';
import { documentState } from './track-ui.js';
import { read as readMidi } from './midi-file.js';

/**
 * The quantize dialog's fields, as accessibility reports them.
 *
 * `element` is the accessible name (the label MFC gives the control), and
 * `kind` disambiguates: 时值(U): exists BOTH as a combobox and as a textfield,
 * and writing to the wrong one is accepted and ignored. That trap is why the
 * pair is recorded rather than the label alone.
 */
export const QUANTIZE_DIALOG = {
  title: '量化',
  openedBy: '0x8061 (处理 > 量化) once a selection exists',
  windowClass: '#32770',
  fields: {
    duration: {
      label: '时值(U):', kind: 'textfield', element: 43,
      meaning: 'the grid to snap to',
      values: 'a musical note value, in Chinese on this build — 4 分音符, 8 分音符, '
        + '16 分音符, 32 分音符, or a tick count',
      default: '16 分音符',
      warning: 'the combobox with the same label is element 41; setting it does not change '
        + 'the value the dialog uses. Write to the textfield.',
    },
    strength: {
      label: '强度(S):', kind: 'textfield', element: 31,
      meaning: 'how far each note moves toward the grid, as a percentage',
      range: '0-100',
      default: '100 in the shipped dialog, but it PERSISTS across invocations — a previous '
        + '50 leaves 50 here, and 50 moves each note only halfway',
      warning: 'this is the field that produced a false "quantize does nothing" reading. It '
        + 'persists between invocations, so a stale 50 from an earlier dialog silently halves the '
        + 'effect: notes move by a fraction of their offset, do not land on the grid, and the '
        + 'result looks like noise or rounding. Set it explicitly on every call.',
    },
    sensitivity: {
      label: '灵敏度(W):', kind: 'textfield', element: 25,
      meaning: 'how readily a note is considered for quantizing, as a percentage',
      default: '100',
    },
    swing: {
      label: '摇摆(I):', kind: 'textfield', element: 28,
      meaning: 'swing amount; 50 is straight',
      default: '50',
    },
    offset: {
      label: '偏移(O):', kind: 'textfield', element: 22,
      meaning: 'ticks to shift the grid by',
      default: '0',
    },
  },
  buttons: { ok: { label: '确定', element: 11 }, cancel: { label: '取消', element: 10 } },
  checkboxes: {
    noteStart: { label: 'MIDI 事件的开始时间(T)', meaning: 'quantize note start times — the box that matters for notes' },
    noteDuration: { label: '音符时值(D)', meaning: 'quantize note lengths as well' },
    audioClipStart: { label: '音频剪辑的开始时间(C)' },
    audioSnapBeats: { label: 'AudioSnap 拍(B)' },
    midiOnly: { label: '仅音符和歌词(MIDI)(N)' },
  },
  /*
   * Checkbox state is NOT readable from the element tree — every checkbox reports
   * value=null and only advertises AXToggle. Reading which boxes are ticked needs
   * a screenshot. This is the drawn-vs-exposed split again, inside a dialog that
   * is otherwise fully readable.
   */
  checkboxCaveat: 'checkbox state must be read from a screenshot; the tree exposes the '
    + 'AXToggle action but not the current value',
};

/**
 * The transpose dialog, measured field by field on 2026.10 (32.10.0.021).
 *
 * This is the second editable note dialog and the one that makes pitch changes
 * possible without CakeScript. It is simpler than 量化: one load-bearing number
 * field, and every audio-only control is greyed out when the selection is MIDI
 * — which is a useful signal that the dialog has correctly identified the
 * material it will act on.
 *
 * Measured with the selection empty (select-all on a project with only empty
 * tracks). The dialog opens regardless of content, which matters: it means the
 * dialog path can be exercised without first producing notes.
 */
export const TRANSPOSE_DIALOG = {
  title: '移调',
  openedBy: '0x8066 (处理 > 移调) once a selection exists',
  windowClass: '#32770',
  verified: 'fields read and written on 2026.10 — 数量(A) accepted 3 and read back as 3',
  fields: {
    amount: {
      label: '数量(A):', kind: 'textfield', element: 25,
      meaning: 'the interval to transpose by, in semitones (or whole tones — see wholeTone)',
      default: '0',
      warning: 'this is the field that does the work. It takes a signed integer; a negative '
        + 'value transposes down. Setting it does not commit — 确定 (element 18) does.',
    },
    wholeTone: {
      label: '全音数(D)', kind: 'checkbox', element: 24,
      meaning: 'when checked, 数量 counts whole tones instead of semitones',
      default: 'unchecked (semitones)',
    },
    audioTranspose: {
      label: '音频移调(T)', kind: 'checkbox', element: 23,
      meaning: 'switches the operation to audio; greyed for a MIDI selection',
      default: 'unchecked',
      warning: 'do not tick this for note editing — it hands the job to the Elastic audio '
        + 'engine and the dialog then applies to clips, not notes.',
    },
    algorithm: {
      label: '类型(P):', kind: 'combobox', element: 19,
      meaning: 'the Elastic algorithm, an audio-only control',
      observed: 'Elastique Efficient, greyed out on a MIDI selection',
    },
    radiusPitch: { label: 'Radius 音高一致性:', kind: 'slider', element: 12, meaning: 'audio-only' },
    radiusPhase: { label: 'Radius 相位一致性:', kind: 'slider', element: 6, meaning: 'audio-only' },
    ok: { label: '确定', kind: 'button', element: 18 },
    cancel: { label: '取消', kind: 'button', element: 17 },
    help: { label: '帮助', kind: 'button', element: 16 },
  },
  checkboxCaveat: 'checkbox state must be read from a screenshot; the tree exposes the '
    + 'AXToggle action but not the current value. The two checkboxes that matter here are '
    + '全音数(D) (whole tones instead of semitones) and 音频移调(T) (switch to audio) — both '
    + 'are OFF in the shipped default, and 音频移调 is greyed out whenever the selection is MIDI.',
};

/**
 * Deterministic grid arithmetic, so a quantize result can be checked without
 * SONAR. Pure, and the part of this module the tests can pin.
 */

/** Snap a tick to the nearest multiple of `grid`, never negative. */
export function snapToGrid(tick, grid) {
  const g = Math.max(1, Math.round(grid));
  return Math.max(0, Math.round(tick / g) * g);
}

/** A musical note value as ticks, for a given PPQ. */
export const NOTE_VALUE_TICKS = {
  'whole': 4, '1/1': 4, '全音符': 4,
  'half': 2, '1/2': 2, '2 分音符': 2,
  'quarter': 1, '1/4': 1, '4 分音符': 1,
  '8th': 0.5, '1/8': 0.5, '8 分音符': 0.5,
  '16th': 0.25, '1/16': 0.25, '16 分音符': 0.25,
  '32nd': 0.125, '1/32': 0.125, '32 分音符': 0.125,
};

/** Ticks per grid step for a note value, at a given PPQ (SONAR uses 480). */
export function gridTicks(noteValue, ppq = 480) {
  const beats = NOTE_VALUE_TICKS[String(noteValue).trim()];
  if (beats === undefined) return null;
  return Math.round(beats * ppq);
}

/**
 * What a quantize should have done, computed locally.
 *
 * `strength` matters: at 100 every note lands on the grid, at 50 each moves
 * halfway. Modelling it here is what turns the export into a checkable
 * prediction rather than a number to eyeball.
 *
 * A non-numeric strength falls back to 100 rather than propagating NaN. The old
 * `Math.max(0, Math.min(100, Number(x)))` turned 'abc' into NaN, and NaN silently
 * poisoned every predicted tick — so each comparison came back false and the
 * caller was told the dialog's settings must differ. A wrong answer dressed as a
 * finding. Falling back to the honest default at least yields a prediction that
 * can be compared; judgeQuantize separately flags that the value was rejected.
 */
export function predictQuantize(ticks, grid, strength = 100) {
  // A boolean or null must not coerce to a strength: Number(true) is 1 and
  // Number(null) is 0, both of which would be silently obeyed as real settings.
  const numericish = typeof strength === 'number'
    || (typeof strength === 'string' && strength.trim() !== '' && Number.isFinite(Number(strength)));
  const n = numericish ? Number(strength) : NaN;
  const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100;
  const s = pct / 100;
  return ticks.map((t) => {
    const target = snapToGrid(t, grid);
    return Math.max(0, Math.round(t + (target - t) * s));
  });
}

/**
 * Compare what was asked for against what the file now holds.
 * Returns a verdict rather than a diff, because "the numbers differ" is not the
 * question — "did the notes land on the grid" is.
 */
export function judgeQuantize({ before, after, grid, strength = 100, swing = 50 }) {
  if (!Number.isFinite(grid) || grid <= 0 || !Number.isInteger(grid)) {
    const e = new Error(`grid must be a positive integer number of ticks, got ${grid}`);
    e.code = 'BAD_GRID';
    throw e;
  }
  // A negative or non-finite tick is not a position. The old code accepted
  // before:[-119], after:[-120] and reported quantizeProven:true, because both
  // values happened to be congruent to the grid.
  for (const [label, arr] of [['before', before], ['after', after]]) {
    if (!Array.isArray(arr)) {
      const e = new Error(`${label} must be an array of ticks`);
      e.code = 'BAD_TICKS';
      throw e;
    }
    for (const t of arr) {
      if (!Number.isFinite(t) || t < 0) {
        const e = new Error(`${label} contains an invalid tick ${t}; ticks are non-negative numbers`);
        e.code = 'BAD_TICKS';
        throw e;
      }
    }
  }
  /*
   * Coerce once, here, so every branch below reasons about the same number the
   * prediction used. Two separate traps were found by attacking this:
   *
   *   - the confidence text tested the RAW argument, so a strength that coerced to
   *     NaN was clamped to NaN by predictQuantize while the message still chose the
   *     non-100 branch: two notions of strength in one result.
   *   - `Number(true)` is 1, so a boolean strength sailed through as "valid, 1%".
   *     A bare Number() accepts booleans, null (0) and arrays; only a number or a
   *     numeric string is a strength. Anything else is refused and reported.
   */
  const isNumericish = typeof strength === 'number'
    || (typeof strength === 'string' && strength.trim() !== '' && Number.isFinite(Number(strength)));
  const s = isNumericish ? Number(strength) : NaN;
  const outOfRange = Number.isFinite(s) && (s < 0 || s > 100);
  const safeStrength = Number.isFinite(s) ? Math.max(0, Math.min(100, s)) : 100;
  const strengthInvalid = !Number.isFinite(s);

  const predicted = predictQuantize(before, grid, safeStrength);
  const onGrid = (t) => t % grid === 0;

  const countChanged = after.length !== before.length;
  const matchedPrediction = after.length === predicted.length
    && after.every((t, i) => t === predicted[i]);
  // Vacuous-truth guard: `[].every()` is true, but an EMPTY result carries no
  // grid evidence at all. Reporting allOnGrid:true for after:[] invited callers
  // to conclude "the quantize worked" from a result where every note vanished
  // (audit finding F2). With no notes, the claim is unfalsifiable — report it as
  // unproven, and quantizeProven below carries the honest verdict.
  const allOnGrid = after.length > 0 && after.every(onGrid);
  // Proven = survivors exist AND all on grid. A PARTIAL count change with
  // on-grid survivors is still a proven quantize (SONAR merging overlaps is the
  // ordinary case); only an EMPTY result destroys the evidence, and that is
  // handled in the count branch below.
  // A swung quantize moves the off-beat subdivisions, so the straight-grid
  // on-grid test cannot confirm it. The round-5 audit found a swung case
  // reporting "quantized — every note lands on the grid" with quantizeProven:true.
  const swung = Number(swing) !== 50;
  const quantizeProven = allOnGrid && !swung;
  const changed = after.some((t, i) => t !== before[i]) || countChanged;

  /*
   * A note count change is its own finding, and must be reported as one.
   *
   * Three audits of this function found holes from different sides. The verdict
   * branched only on `matchedPrediction` and `allOnGrid`, so:
   *   - before == after (nothing happened at all) with strength 0 matched the
   *     prediction — which also predicts no movement — and produced the reassuring
   *     "not a failure". A commit that never applied read as a legitimate no-op.
   *   - a changed note count (a note added or dropped by the edit or the export)
   *     made matchedPrediction false and, if the survivors were on-grid, produced
   *     "the dialog may have applied different settings than were written" — a
   *     settings explanation for what is actually a missing note.
   *   - and "nothing moved" itself has TWO causes, not one. If the source notes were
   *     already on the grid, a quantize correctly does nothing and that is a
   *     SUCCESS; reporting it as "the commit most likely did not apply" turns a
   *     working run into a suspected failure. That case is decidable from the input,
   *     so it is decided rather than guessed at.
   */
  // `[].every()` is true, so an empty BEFORE list made "everything was already on
  // the grid" vacuously true and produced a SUCCESS verdict for two empty lists.
  const beforeOnGrid = before.length > 0 && before.every(onGrid);
  /*
   * Two independent reasons a quantize legitimately changes nothing, and both must
   * be recognised or a working run is reported as a suspected failure:
   *   - the source notes were already on the grid
   *   - the strength was 0, which asks for no movement by definition
   * The first version of this check only tested the grid, so `strength: 0` on
   * off-grid notes was reported as "the commit most likely did not apply" — which
   * an attacker found immediately, because that is exactly what a 0% strength is
   * for.
   */
  const noMovementAsked = safeStrength === 0;
  const alreadyAligned = !changed && !countChanged && (beforeOnGrid || noMovementAsked);

  let verdict;
  if (before.length === 0 && after.length === 0) {
    // Two empty lists are not evidence of success — there is nothing to judge.
    verdict = 'no notes in the before/after lists, so there is nothing to judge. '
      + 'This is NOT a success claim: export a selection that actually contains notes.';
  } else if (countChanged) {
    /*
     * A count change must be reported, but not at the cost of hiding a success.
     * This branch fires before any position comparison, so it used to declare "not
     * a quantize result" even when every surviving note had landed exactly on the
     * grid — which is an ordinary outcome when SONAR merges same-pitch overlapping
     * notes on export, and leaves the caller with no way to see that the quantize
     * itself worked. `allOnGrid` is already computed; it is used now.
     */
    // `allOnGrid` is `[].every()` on an empty array — vacuously true — so an
    // EMPTY after[] used to read as "the quantize itself worked" while the note
    // count said every note vanished. Both cannot be concluded at once; with no
    // survivors there is no position evidence at all, and the honest verdict is
    // unconfirmed. Same for a partial count change: fewer survivors weakens the
    // claim, zero survivors destroys it.
    const gridNote = quantizeProven
      ? ` Every note that IS present landed on the grid, so the quantize itself worked — the `
        + `count difference is separate and probably comes from the export merging or dropping `
        + `notes (SONAR merges same-pitch overlaps).`
      : after.length === 0
        ? ' NO notes remain, so there is no position evidence either way — the quantize result '
          + 'is UNCONFIRMED, not proven. Find where the notes went before trusting any claim '
          + 'about the edit.'
        : ' The surviving notes are not all on the grid either, so treat this as inconclusive '
          + 'rather than as either a success or a failure.';
    verdict = `note count changed: ${before.length} before, ${after.length} after. `
      + 'That is not something a quantize does — the edit added or removed notes, or the export '
      + 'did.' + gridNote;
  } else if (alreadyAligned && noMovementAsked) {
    verdict = 'nothing moved, and nothing was asked to — strength 0 means no change is the '
      + 'correct result. This says nothing about whether a strength-based quantize would work.';
  } else if (alreadyAligned) {
    verdict = 'nothing moved, and nothing needed to — every source note was already on the grid, '
      + 'so a quantize correctly has no effect. This is a SUCCESS, not a failure, and it is also '
      + 'why quantizing an already-quantized file proves nothing: write notes deliberately off the '
      + 'grid (see cw_quantize_plan) if you are testing whether the round trip works.';
  } else if (!changed) {
    verdict = 'nothing moved, but notes were off the grid and the strength asked them to move. '
      + 'The commit most likely did not apply: check whether the dialog was still open, or '
      + 'whether it was dismissed with 取消 rather than 确定. This is NOT a quantize result.';
  } else if (matchedPrediction) {
    verdict = allOnGrid
      ? (swung
        ? 'the notes moved to the straight grid, but a SWUNG quantize was requested: the swung '
          + 'positions are not what a straight grid produces, so this is not a swung-quantize result'
        : 'quantized — every note lands on the grid')
      : 'moved part of the way — consistent with a fractional strength, not a failure';
  } else if (allOnGrid) {
    verdict = 'every note is on the grid but the positions differ from the prediction; the '
      + 'dialog may have applied different settings than were written';
  } else {
    verdict = 'the notes moved but do not match the prediction and are not on the grid — the '
      + 'strength or 灵敏度 differed from what was written';
  }

  return {
    changed,
    countChanged,
    allOnGrid,
    quantizeProven,
    matchedPrediction,
    predicted,
    actual: after,
    verdict,
    // The prediction models a straight grid. With swing the odd subdivisions move,
    // so an on-grid verdict is not evidence that a swung quantize applied.
    swing: Number(swing),
    swingModelled: Number(swing) === 50,
    ...(Number(swing) !== 50 ? {
      swingNote: 'swing ' + swing + ' is not modelled by this verdict: on-grid here means the '
        + 'straight grid only. Judge the result against the swung positions the dialog used.',
    } : {}),
    // A malformed strength silently produced all-NaN predictions, which made every
    // comparison false and every message about "settings differing". Say so
    // instead, because the caller cannot tell that from the output alone.
    strengthUsed: safeStrength,
    /*
     * `strengthAdjusted` covers BOTH ways a supplied value can fail to be the one
     * used: it was not a number at all, or it was a number outside 0-100 and got
     * clamped. The earlier version only flagged the first, so `strength: 150`
     * silently became 100 and `strength: -10` silently became 0 with no warning —
     * a verifier found this, and it is the same class of defect as the fabricated
     * whatToLook: the record implying a value was used that was not.
     */
    strengthAdjusted: strengthInvalid || outOfRange,
    strengthInvalid,
    strengthOutOfRange: outOfRange,
    strengthWarning: strengthInvalid
      ? `strength '${String(strength)}' is not a finite number, so it was ignored and 100 was `
        + 'used for the prediction. The dialog was not necessarily set to 100 — re-run with the '
        + 'value you actually wrote.'
      : outOfRange
        ? `strength ${s} is outside 0-100, so it was clamped to ${safeStrength} for the `
          + 'prediction. The dialog may not have accepted the value you sent either — re-run with '
          + 'a strength in range.'
        : undefined,
    /*
     * How far the prediction can be trusted, stated per strength rather than in
     * general. At 100 the modal output matched this model on all 8 notes of the
     * measured run, so it is a real check. At intermediate strengths it is NOT:
     * the one 50% observation differed by up to 59 ticks on a single note, which
     * is more than rounding and most likely the persisted `灵敏度` interacting
     * with strength. One sample cannot separate those, and fitting a constant to
     * it would be inventing precision. So partial strength gets a warning.
     */
    predictionConfidence: safeStrength === 100
      ? 'exact at full strength — verified against a measured run on all 8 notes'
      : 'approximate at partial strength — the model assumes a linear move to the grid. In the '
        + 'one 50% observation, 7 of 8 notes matched the model to within a tick of rounding; a '
        + 'single note was 59 ticks off (source 2461, measured 2432, model 2491). One sample '
        + 'cannot say why — the persisted 灵敏度, a grid-line tie, or something else — and fitting '
        + 'a constant to it would be inventing precision. Treat a mismatch at partial strength as '
        + 'inconclusive rather than as failure, and set 灵敏度 explicitly on the next attempt.',
    controlNote: 'If this reads as "nothing happened", import the same file and export it with '
      + 'no edit first. That control shows whether export alone moves ticks. On this build it '
      + 'does not (measured: zero drift), so any movement is the edit.',
  };
}

// --- the interactive chain ---------------------------------------------------

/**
 * Note start ticks from a .mid file, sorted, flattened across tracks.
 *
 * This is the reading half of the verification round trip. It lives here rather
 * than in the caller because both sides of a quantize check must be read the
 * same way: if `before` came from our own writer and `after` from SONAR's export,
 * a difference in track selection or sort order would show up as a false
 * mismatch. One function, one ordering, both sides.
 */
export function readTicks(path) {
  const r = readMidi(path);
  const ticks = [];
  for (const t of r.tracks) for (const n of t.notes) ticks.push(n.tick);
  return ticks.sort((a, b) => a - b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a 处理 command, wait for its dialog, and report whether it opened.
 *
 * The wait is the fix for measurement mistake 1: the window list is checked
 * after the modal loop has had a chance to create the dialog, not immediately.
 */
export async function openDialogFor(cmdId, { selectFirst = true, waitMs = 1600 } = {}) {
  const doc = await documentState();
  if (!doc.projectOpen) {
    const e = new Error('No document is open, so there is nothing to edit.');
    e.code = 'NO_DOCUMENT';
    throw e;
  }
  if (selectFirst) {
    await runCommand(0x804C, { keepOverlays: true });  // 编辑 > 选择 > 全部
    await sleep(700);
  }
  await runCommand(cmdId, { keepOverlays: true });
  await sleep(waitMs);
  const st = await call('status');
  const dialogs = (st.allWindows || [])
    .filter((w) => w.cls === '#32770')
    .map((w) => ({ cls: w.cls, title: w.title, hwnd: w.hwnd }));
  return { opened: dialogs.length > 0, dialogs };
}

/**
 * Everything a computer-use runtime needs to drive the quantize dialog, with
 * the settings it should write, so the two cannot drift apart.
 *
 * This process cannot perform the AXSetValue/AXPress steps itself — they need a
 * runtime with accessibility. What it can do is state the exact plan, including
 * the field kinds, and the checks that prove it worked.
 */
export function quantizePlan({ grid = '16 分音符', strength = 100, sensitivity = 100,
  swing = 50, offset = 0 } = {}) {
  const f = QUANTIZE_DIALOG.fields;
  return {
    tool: 'cw_edit',
    command: 'quantize',
    opensDialog: QUANTIZE_DIALOG.title,
    writes: [
      { field: 'duration', label: f.duration.label, kind: f.duration.kind, value: grid,
        why: f.duration.warning },
      { field: 'strength', label: f.strength.label, kind: f.strength.kind, value: String(strength),
        why: 'set this explicitly — it persists between invocations and a stale 50 produces a '
          + 'half-quantize that looks like a failure' },
      { field: 'sensitivity', label: f.sensitivity.label, kind: f.sensitivity.kind, value: String(sensitivity) },
      { field: 'swing', label: f.swing.label, kind: f.swing.kind, value: String(swing) },
      { field: 'offset', label: f.offset.label, kind: f.offset.kind, value: String(offset) },
    ],
    commit: { action: 'AXPress', label: QUANTIZE_DIALOG.buttons.ok.label },
    afterCommit: 'The dialog closes. Do not read the window list in the same breath — the close '
      + 'is asynchronous. Wait about two seconds, then check.',
    verify: {
      why: 'Nothing in the UI reports note times, so the commit must be checked from data.',
      how: 'Export with 文件 > 导出 > 标准 MIDI 文件 (0xA659, opens the 保存副本 dialog; write '
        + 'the filename field and press 保存(S)), then parse the file with cw_read_midi_file.',
      control: 'Before concluding a quantize did nothing, export the SAME file with no edit and '
        + 'compare. Zero drift on this build means export is faithful.',
    },
    checkboxCaveat: QUANTIZE_DIALOG.checkboxCaveat,
  };
}

/**
 * The plan for a transpose, the same shape as quantizePlan.
 *
 * Transpose is the second editable note dialog and the one that makes pitch
 * changes possible without CakeScript, so it is worth the same treatment: state
 * the exact fields, the exact values, and how to prove the commit landed.
 *
 * `semitones` is signed. A negative value transposes down, which is worth
 * saying because the field's default of 0 reads like "no value" rather than
 * "shift by nothing".
 */
export function transposePlan({ semitones = 0, wholeTones = false } = {}) {
  const f = TRANSPOSE_DIALOG.fields;
  return {
    tool: 'cw_edit',
    command: 'transpose',
    opensDialog: TRANSPOSE_DIALOG.title,
    writes: [
      { field: 'amount', label: f.amount.label, kind: f.amount.kind, value: String(semitones),
        why: 'the interval. Signed: a negative value transposes down.' },
      ...(wholeTones
        ? [{ field: 'wholeTone', label: f.wholeTone.label, kind: f.wholeTone.kind,
            value: 'toggle on', why: 'amount counts whole tones instead of semitones' }]
        : []),
    ],
    doNotTouch: [
      { field: 'audioTranspose', label: f.audioTranspose.label, why: f.audioTranspose.warning },
      { field: 'algorithm', label: f.algorithm.label, why: 'audio-only; greyed out for MIDI' },
    ],
    commit: { action: 'AXPress', label: f.ok.label },
    afterCommit: 'The dialog closes. The close is asynchronous — do not read the window list in '
      + 'the same breath. Wait about two seconds, then check.',
    verify: {
      why: 'Nothing in the UI reports note pitches, so the commit must be checked from data.',
      how: 'Export with 文件 > 导出 > 标准 MIDI 文件 (0xA659, which opens the 保存副本 dialog; '
        + 'write the filename field and press 保存(S)), then parse with cw_read_midi_file and '
        + 'compare each note pitch against the source.',
      // wholeTones changes what the dialog DOES with `semitones`: the checkbox
      // makes the amount count WHOLE TONES, so 2 with the box on is 4 semitones.
      // The expectation used to echo the raw number, telling the verifier to
      // expect exactly half the real shift (audit finding F5).
      expect: `every note pitch should have moved by exactly `
        + `${semitones * (wholeTones ? 2 : 1)} semitone(s) `
        + `(amount ${semitones} ${wholeTones ? 'whole tone(s)' : 'semitone(s)'})`,
      control: 'Before concluding a transpose did nothing, export the same content with no edit '
        + 'and compare — export on this build is faithful (zero drift), so any difference is the edit.',
    },
    checkboxCaveat: TRANSPOSE_DIALOG.checkboxCaveat,
  };
}

/** Everything about note-level editing, for cw_note_edit_help. */
export function noteEditHelp() {
  return {
    summary:
      'Notes cannot be READ through any automation surface, but they can be EDITED. The path is '
      + 'a dialog behind the command, and the proof is the exported file.',
    chain: [
      { step: 1, action: '编辑 > 选择 > 全部', cmdId: 0x804C, why: 'every 处理 command needs a selection' },
      { step: 2, action: '处理 > 量化', cmdId: 0x8061, why: 'opens the 量化 dialog' },
      { step: 3, action: 'AXSetValue on the fields', why: 'writes land in an MFC dialog' },
      { step: 4, action: 'AXPress 确定', why: 'commits; closes asynchronously' },
      { step: 5, action: '文件 > 导出 > 标准 MIDI 文件', cmdId: 0xA659, why: 'the only witness to what changed' },
      { step: 6, action: 'cw_read_midi_file', why: 'reads the tick positions back' },
    ],
    dialogs: { quantize: QUANTIZE_DIALOG, transpose: TRANSPOSE_DIALOG },
    verified: {
      quantize: 'Measured end to end. Source notes written deliberately off-grid at '
        + '30/530/935/1477/1877/2461/2862/3404. After quantize at 16th/100%, the exported file '
        + 'held 0/480/960/1440/1920/2520/2880/3360 — every note exactly on the grid. A control '
        + 'export with no edit returned the source ticks unchanged.',
      halfStrength: 'At the dialog default of 50%, the same source produced '
        + '16/506/948/1460/1899/2432/2872/3383. Seven of those eight agree with '
        + 'predictQuantize() to within a tick of rounding; the eighth (source 2461, measured 2432, '
        + 'model 2491) is 59 ticks off, so the linear model does NOT match at partial strength — '
        + 'see predictionConfidence for why that is recorded as approximate rather than fitted. '
        + 'This is the reading that was first mistaken for failure: at 50% the notes move but stay '
        + 'off the grid, which looks like export noise until a no-edit control rules that out.',
    },
    limits: [
      'Reading notes still has no surface: the export-and-parse round trip is the only reader, '
        + 'so it costs a file write per read.',
      '量化 and 移调 are measured field by field. The rest of the 处理 menu — 力度, 音长, 倒置, '
        + '时间匹配, 查找/更改, 移动 and the 轻移 family — are postable and open the same class of '
        + 'dialog, but their element indices are not recorded; see EDIT_COMMANDS in edit.js for '
        + 'which are known to open a dialog and which act silently.',
      'Checkbox state inside the dialog is not exposed — screenshot needed to confirm which '
        + 'boxes are ticked.',
      'A 处理 command with no selection does nothing at all, which is why selectFirst exists.',
    ],
    mistakesRecorded: [
      'Reading the window list immediately after AXPress reports the dialog as still open; the '
        + 'close is asynchronous. Wait, then check.',
      'Without a no-edit control export, the 50%-strength half-movement looks like noise and '
        + 'leads to "quantize is broken" — which is wrong. Always export a control.',
    ],
  };
}
