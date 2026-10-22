// test/edit.test.mjs — the editing layer, and the precondition that makes it work.
//
// This module carries the round's most useful correction: three edit commands
// reported `unconfirmed` when probed with no selection, and the tempting reading
// was "they do not work". They work — an edit on an empty selection is meant to
// do nothing. The tests below pin both halves: that the precondition is declared
// for every command, and that satisfying it is what the runner does.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDIT_COMMANDS, EDIT_DIALOGS, edit, editHelp, withSelection, classifyEditResult,
  requireWindowList,
} from '../lib/edit.js';
import { NO_EFFECT_CAUSES } from '../lib/verify.js';

// This suite is process-free by design. The tests that ran a real edit (and so
// waited on SONAR) now live in integration.test.mjs; everything they were
// checking about the REPORT is covered here through classifyEditResult, which is
// the pure function that used to be inlined in edit().

// --- the record ---------------------------------------------------------------

test('every edit command declares a precondition', () => {
  for (const [key, cmd] of Object.entries(EDIT_COMMANDS)) {
    assert.ok(cmd.name && cmd.en, `${key} needs both names`);
    assert.match(cmd.hex, /^0x[0-9A-F]{4}$/);
    // The selection commands exist to BE the precondition, so they say none.
    if (key === 'selectAll' || key === 'selectNone') continue;
    assert.ok(cmd.precondition, `${key} must state what it needs first`);
  }
});

test('the three commands verified to open a dialog record that fact', () => {
  for (const key of ['quantize', 'transpose', 'splitClips']) {
    const cmd = EDIT_COMMANDS[key];
    assert.ok(cmd.outcome.includes('dialog'), `${key} opens a dialog, so say so`);
    assert.ok(cmd.verified, `${key} was verified — record how`);
    assert.ok(cmd.verified.includes('selection'),
      `${key}: the verification IS the selection precondition, so name it`);
  }
});

// --- the field indices measured on 2026-10-15 ---------------------------------
//
// These are the load-bearing numbers: a caller drives a dialog by element index,
// and an index that drifts silently mis-writes a field. They are pinned here so
// that editing the prose around them cannot quietly change what it claims.

test('the measured dialogs record their element indices, not just their prose', () => {
  // Each entry: command key -> [element index, a fragment of the label it belongs to].
  const expected = {
    scaleVelocity: [[9, '开始'], [7, '结束'], [5, '确定']],
    length: [[24, '按照'], [26, '时值'], [27, '开始时间'], [17, '确定']],
    fitToTime: [[27, '新结束时间'], [24, '事件时间'], [18, '确定']],
    slide: [[10, '移动量'], [9, '小节'], [5, '确定']],
    grooveQuantize: [[59, '律动样板'], [55, '精度'], [57, '精度'], [11, '确定']],
  };
  for (const [key, pairs] of Object.entries(expected)) {
    const v = EDIT_COMMANDS[key].verified;
    assert.ok(v.includes('MEASURED'), `${key} claims to be measured — say so`);
    for (const [idx, label] of pairs) {
      // The label and the index must be tied together, in either order. A label
      // whose controls are described as a pair (精度 = 55 combobox AND 57
      // textfield) is checked once per index, so the tie is `label` somewhere
      // before or after `= idx` within the same sentence.
      const re = new RegExp(`${label}[^.]{0,60}?\\b${idx}\\b|\\b${idx}\\b[^.]{0,60}?${label}`);
      assert.ok(re.test(v), `${key}: the record must tie element ${idx} to "${label}"`);
    }
  }
});

test('retrograde is recorded as a pitch mirror, not a re-ordering', () => {
  const cmd = EDIT_COMMANDS.retrograde;
  // The first guess ("reverses the order of the notes") was wrong: measured, the
  // ticks stay put and the pitches reverse. The record must carry the correction,
  // because the wrong version reads perfectly plausible.
  assert.match(cmd.affects, /pitch/i);
  assert.match(cmd.verified, /same ticks|ticks do not move|at the SAME ticks/i,
    'the correction must state what actually stayed fixed');
  assert.equal(cmd.outcome.includes('silent'), true,
    'it opens no dialog — a caller that waits for one will hang');
});

test('findChange is recorded as a selector, not a replacer', () => {
  const cmd = EDIT_COMMANDS.findChange;
  // Also corrected by measurement: 事件过滤器 - 搜索 narrows the selection; it
  // does not modify events. The old wording said "batch-replaces".
  assert.match(cmd.affects, /SELECT/i);
  assert.doesNotMatch(cmd.affects, /replace/i);
  assert.match(cmd.outcome, /事件过滤器/);
});

test('nudgeSettings is marked as a preference change, not project data', () => {
  const cmd = EDIT_COMMANDS.nudgeSettings;
  assert.equal(cmd.risk, 'destructive');
  assert.match(cmd.riskWhy, /preference/i);
  assert.match(cmd.verified, /参数设置/);
});

test('the nudge steps record what each step actually is', () => {
  const v = EDIT_COMMANDS.nudgeSettings.verified;
  // The three steps are independently configured, not a small/medium/large ramp —
  // and step 1's 10 ms default is why a nudge appears to do nothing.
  assert.match(v, /轻移 1 = 10 毫秒/);
  assert.match(v, /轻移 2 = 1 帧/);
  assert.match(v, /轻移 3 = 2 帧/);
  assert.match(EDIT_COMMANDS.nudgeLeft1.outcome, /silent/,
    'the time nudges open no dialog either');
});

test('destructive commands are marked as such', () => {
  const destructive = Object.entries(EDIT_COMMANDS).filter(([, c]) => c.risk === 'destructive');
  assert.ok(destructive.length >= 5, 'splitting, merging and the audio processes all destroy');
  for (const [key, cmd] of destructive) {
    assert.ok(cmd.affects, `${key} is destructive, so it must say what it changes`);
  }
});

test('risk is a canonical value, never prose', () => {
  // This test exists because the prose form was a real bug: `risk: 'destructive
  // — the source events are replaced'` does not equal the literal the guard
  // compares against, so the confirmation check silently stopped working for
  // three commands. A category field must hold only the category.
  const allowed = new Set(['low', 'medium', 'high', 'destructive', undefined]);
  for (const [key, cmd] of Object.entries(EDIT_COMMANDS)) {
    if (cmd.risk === undefined) continue;
    assert.ok(allowed.has(cmd.risk),
      `${key} has risk='${cmd.risk}' — use a canonical value and put the reason in riskWhy`);
  }
});

test('every destructive command actually refuses without confirmation', async () => {
  // The behavioural half of the test above: a value the guard does not recognise
  // would let the command through, and only running it proves otherwise.
  const destructive = Object.entries(EDIT_COMMANDS)
    .filter(([, c]) => c.risk === 'destructive').map(([k]) => k);
  assert.ok(destructive.length >= 5);
  for (const key of destructive) {
    await assert.rejects(
      () => edit(key),
      (e) => e.code === 'NEEDS_CONFIRMATION',
      `${key} is marked destructive but did not refuse`
    );
  }
});

test('the audio processes name audio in their precondition', () => {
  // These are silent on a MIDI-only selection, which is a precondition gap rather
  // than a fault — worth distinguishing in the record.
  for (const key of ['gain', 'normalize', 'reverse', 'removeSilence']) {
    assert.ok(EDIT_COMMANDS[key].precondition.includes('audio'),
      `${key} operates on audio, so its precondition should say so`);
  }
});

test('every edit command is a distinct id', () => {
  const seen = new Map();
  for (const [key, cmd] of Object.entries(EDIT_COMMANDS)) {
    assert.ok(!seen.has(cmd.cmdId), `0x${cmd.cmdId.toString(16)} is both ${seen.get(cmd.cmdId)} and ${key}`);
    seen.set(cmd.cmdId, key);
  }
});

test('the dialogs behind the edits are described with their fields', () => {
  for (const key of ['quantize', 'transpose', 'splitClips']) {
    const d = EDIT_DIALOGS[key];
    assert.ok(d, `${key} should have a dialog description`);
    assert.ok(d.title, `${key}: the dialog title is what a caller searches for`);
    assert.ok(d.how.includes('0x'), `${key}: the command that opens it should be named`);
    assert.ok(d.fields, `${key}: the fields are what the caller has to fill`);
  }
  assert.ok(EDIT_DIALOGS.why.includes('AXSetValue'),
    'why these are writable — the same property the marker and file dialogs have — must be stated');
});

// --- the three-cause taxonomy -------------------------------------------------

test('the no-effect taxonomy has exactly three causes with distinct handling', () => {
  assert.equal(NO_EFFECT_CAUSES.length, 3);
  const names = NO_EFFECT_CAUSES.map((c) => c.cause).sort();
  assert.deepEqual(names, ['drawn-not-exposed', 'gated-by-licence', 'precondition-missing']);
  for (const c of NO_EFFECT_CAUSES) {
    assert.ok(c.howToTell, `${c.cause} needs a way to tell it apart`);
    assert.ok(c.means, `${c.cause} needs to say what it actually means`);
    assert.ok(c.action, `${c.cause} needs a recommended action`);
    assert.ok(c.example, `${c.cause} needs a concrete example`);
  }
});

test('only one of the three causes is described as a limit', () => {
  // Check the meaning, not the substring: the licence-gate action deliberately
  // says "there is nothing to retry", which contains the word while meaning the
  // opposite. Asserting on a substring would make the wording unfixable.
  const gated = NO_EFFECT_CAUSES.find((c) => c.cause === 'gated-by-licence');
  const precond = NO_EFFECT_CAUSES.find((c) => c.cause === 'precondition-missing');
  assert.ok(/nothing to retry|do not retry|no point/i.test(gated.action),
    'a licence gate must be described as final, not as something to keep trying');
  assert.ok(/retry/i.test(precond.action),
    'a missing precondition IS recoverable, so it should invite a retry');
  assert.ok(precond.action.includes('选择'),
    'and name the concrete step that fixes it');
});

test('editHelp carries the taxonomy, not just the command table', () => {
  const h = editHelp();
  assert.ok(h.commands && h.dialogs);
  assert.ok(h.whyPreconditionsMatter, 'the lesson must travel with the module');
  assert.equal(h.whyPreconditionsMatter.causes.length, 3);
  assert.ok(h.editorPrecondition.includes('unconfirmed'),
    'it should say explicitly that an unconfirmed probe is not a verdict');
});

// --- behaviour ----------------------------------------------------------------

test('an unknown edit command is refused with the known list', async () => {
  await assert.rejects(
    () => edit('obliterate'),
    (e) => e.code === 'UNKNOWN_COMMAND' && e.message.includes('quantize')
  );
});

test('a destructive edit refuses without the matching confirm value', async () => {
  await assert.rejects(
    () => edit('normalize'),
    (e) => e.code === 'NEEDS_CONFIRMATION'
  );
  await assert.rejects(
    () => edit('normalize', { confirm: true }),
    (e) => e.code === 'NEEDS_CONFIRMATION'
  );
  await assert.rejects(
    () => edit('splitClips'),
    (e) => e.code === 'NEEDS_CONFIRMATION'
  );
});

test('the refusal names the command and offers the way back', async () => {
  try {
    await edit('mergeClips');
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'NEEDS_CONFIRMATION');
    assert.ok(e.message.includes('mergeClips'), 'the confirm value must be stated');
    assert.ok(e.message.includes('Undo') || e.message.includes('0xE12B'),
      'the only recovery is undo, so say so');
  }
});

test('a safe edit declares the precondition it will satisfy', () => {
  // The live version of this — which actually ran the edit — is in
  // integration.test.mjs. Here we pin that the declaration exists, which is what
  // a caller reads before deciding to run it.
  const q = EDIT_COMMANDS.quantize;
  assert.equal(q.precondition, 'a selection');
  assert.match(q.affects, /note start times/);
  assert.match(q.verified, /select/i, 'the record should say how it was established');
});

test('the result reports dialog-opened rather than claiming success', () => {
  const r = classifyEditResult(EDIT_COMMANDS.quantize, { newWindows: ['#32770|量化'] });
  assert.equal(r.outcome, 'dialog-opened');
  assert.equal(r.likelySwallowed, false);
  assert.match(r.next, /确定/, 'it should say how to complete the dialog');
});

/*
 * The second false positive, found by auditing this module against its own stated
 * principle ("it never pretends to have succeeded"). The field used to read
 * `preconditionSatisfied: 'selected all first'` — asserted unconditionally from
 * the `selectFirst` flag, with no observation behind it. Select-all is a drawn
 * change: no window, no element, just a highlighted ruler. So a modal that
 * swallowed the menu command would leave the field claiming a selection it never
 * made, right next to a `likelySwallowed: true` saying the command vanished.
 */
test('the selection precondition is reported as an attempt, never as confirmed', () => {
  const r = classifyEditResult(EDIT_COMMANDS.quantize, { newWindows: [] });
  assert.match(r.selectionRequested, /选择 > 全部/, 'report what was posted');
  assert.equal(r.selectionConfirmed, false,
    'the selection must never be reported as confirmed — nothing here can observe it');
  assert.match(r.selectionEvidence, /screenshot/,
    'and it must say what WOULD settle it');
  assert.equal('preconditionSatisfied' in r, false,
    'the old field claimed an outcome this process cannot observe and must not return');
});

test('the swallowed-command case does not also claim a selection was made', () => {
  // The contradiction the old wording allowed: command did nothing, selection
  // reported as satisfied.
  const r = classifyEditResult(EDIT_COMMANDS.quantize, { newWindows: [] });
  assert.equal(r.likelySwallowed, true);
  assert.equal(r.selectionConfirmed, false);
});

/*
 * The false-positive this pins. `expected` describes what the command does when
 * it works; `outcome` reports what was seen. Before the split they were the same
 * field, so a run that opened no window still read as though a dialog had
 * opened — which happened in a real session and would have hidden a failure.
 */
test('a command that should open a dialog but did not is reported as no-window-change', () => {
  const r = classifyEditResult(EDIT_COMMANDS.quantize, { newWindows: [] });
  assert.equal(r.outcome, 'no-window-change',
    'outcome must state what was seen, not what the command normally does');
  assert.match(r.expected, /dialog/i, 'the description belongs in expected');
  assert.notEqual(r.outcome, r.expected, 'the two fields must not be interchangeable');
});

test('a swallowed command says how to recover', () => {
  const r = classifyEditResult(EDIT_COMMANDS.quantize, { newWindows: [] });
  assert.equal(r.likelySwallowed, true);
  assert.match(r.next, /modal|overlay/i, 'name the usual cause');
  assert.match(r.next, /cw_close_overlays|cw_list_overlays/, 'name the tools that fix it');
});

test('a command that legitimately does not open a dialog is not flagged', () => {
  // splitAtNow is silent by design, so no window is the expected result.
  const r = classifyEditResult(EDIT_COMMANDS.splitAtNow, { newWindows: [], selectFirst: false });
  assert.equal(r.likelySwallowed, false);
  assert.match(r.selectionRequested, /not attempted/);
});

test('the result carries the command identity a caller needs to trust it', () => {
  const r = classifyEditResult(EDIT_COMMANDS.transpose, { newWindows: [] });
  assert.equal(r.cmdId, 0x8066);
  assert.equal(r.hex, '0x8066');
  assert.equal(r.ran, EDIT_COMMANDS.transpose.name);
  assert.equal(r.risk, EDIT_COMMANDS.transpose.risk);
});

test('withSelection is exported and takes the assumeSelected escape', async () => {
  // The behaviour of withSelection on a live document is in integration.test.mjs,
  // because it posts 编辑 > 选择 > 全部 through the bridge. What belongs here is
  // that the escape hatch exists and is honoured — a caller with an existing
  // selection must not pay for a redundant select-all.
  //
  // The old second assertion here was `assert.equal(withSelection.length >= 1, true)`,
  // which is true of every function that takes an argument and could not fail. An
  // adversarial audit flagged it; what it was groping for is checked properly by
  // calling the function below.
  assert.equal(typeof withSelection, 'function');
  let ran = false;
  await withSelection(async () => { ran = true; }, { assumeSelected: true });
  assert.ok(ran, 'the wrapped function must run');
});

test('withSelection returns its result in `out`, not bare', async () => {
  // The wrapper had to start returning more than the function's value once the
  // selection post became something a caller might want to inspect. That changed
  // the contract of an exported function, so it is pinned here: a caller that
  // awaits it gets an object, and the wrapped value is under `out`.
  const r = await withSelection(async () => ({ marker: 42 }), { assumeSelected: true });
  assert.equal(r.out.marker, 42, 'the wrapped result must be under `out`');
  assert.equal(r.assumeSelected, true);
  assert.equal(r.selectionPost, null, 'no post is made when the caller already has a selection');
});

/*
 * A note on what is deliberately NOT here.
 *
 * There used to be a test named "the window list flows from withSelection into
 * the classifier". It built a fake `out`, passed it to classifyEditResult, and
 * asserted the value survived — which is true of any function that returns its
 * argument. It never touched `edit()`, so the regression it was named for (reading
 * `ran.newWindows` off the wrapper instead of off `out`) left it green. An
 * adversarial verifier injected that exact bug and watched this file pass 25/25.
 *
 * It was deleted, and the guard moved into edit() as `requireWindowList`. The
 * regression is now caught where it happens rather than hoped for downstream:
 * the plumbing bug produced `ran.newWindows === undefined`, and the guard turns
 * that into an EDIT_WIRING_FAULT instead of a plausible empty window list.
 *
 * The tests below pin the guard directly. They are the deterministic coverage
 * for that regression — they need no SONAR and no project. The end-to-end check
 * still lives in integration.test.mjs, but it can only be absolute when a
 * project containing MIDI notes is open (see the todo branch there).
 */

test('requireWindowList passes a real window list through unchanged', async () => {
  const list = ['#32770|��������', 'Afx:...|HUDNow'];
  assert.deepEqual(requireWindowList({ newWindows: list }), list);
  // An empty list is legitimate — it is what a correct edit against an empty
  // project produces. The guard must not treat it as an error.
  assert.deepEqual(requireWindowList({ newWindows: [] }), []);
});

test('requireWindowList rejects the shape the plumbing regression produced', async () => {
  // The exact injected bug: `withSelection` returns { out, ... } and the caller
  // read `.newWindows` off the wrapper, yielding undefined.
  const wrapper = { out: { newWindows: ['#32770|x'] }, selectionPost: null, assumeSelected: false };
  assert.throws(
    () => requireWindowList(wrapper),
    (e) => e.code === 'EDIT_WIRING_FAULT' && /wiring fault/i.test(e.message),
    'reading the list off the wrapper instead of off `out` must be a named failure'
  );
  assert.throws(() => requireWindowList(undefined), (e) => e.code === 'EDIT_WIRING_FAULT');
  assert.throws(() => requireWindowList({}), (e) => e.code === 'EDIT_WIRING_FAULT');
  assert.throws(() => requireWindowList({ newWindows: null }), (e) => e.code === 'EDIT_WIRING_FAULT');
  // A string is not a list: .some/.filter would misbehave on it.
  assert.throws(() => requireWindowList({ newWindows: '#32770|x' }), (e) => e.code === 'EDIT_WIRING_FAULT');
});

test('the wiring fault carries what it received, for diagnosis', async () => {
  try {
    requireWindowList({ out: { newWindows: [] }, selectionPost: 'x' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'EDIT_WIRING_FAULT');
    assert.deepEqual(e.got, { out: { newWindows: [] }, selectionPost: 'x' },
      'the offending value must travel with the error — the difference between the two '
      + 'shapes is the whole diagnosis');
  }
});

test('edit reports the affected parameter for a destructive command', async () => {
  // The refusal is raised from the pure guard, before any process is touched, so
  // this answers immediately and does not care whether SONAR is running.
  await assert.rejects(
    () => edit('reverse'),
    (e) => {
      assert.equal(e.code, 'NEEDS_CONFIRMATION');
      assert.match(e.message, /audio/, 'the refusal should say what it would change');
      return true;
    }
  );
});
