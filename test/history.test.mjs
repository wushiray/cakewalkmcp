// test/history.test.mjs — the undo layer, process-free.
//
// What is tested here: the record (command ids, risk, what each claims to have
// been verified), the measured dialog table, and the honest wording about
// confirmation — undo opens no window, so this module's whole job is to say so
// clearly instead of reporting a cheerful success it cannot substantiate.
//
// What is NOT here: whether undo actually rewinds. That was measured by hand on
// 2026-10-15 (16 notes -> 8 after rewinding to an older stack entry) and is
// recorded in the `verified` fields rather than re-asserted, because the fast
// tier cannot reach SONAR.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_COMMANDS, HISTORY_DIALOG, historyHelp, step, undo, redo,
} from '../lib/history.js';

describe('the history command record', () => {
  test('every command carries the metadata the invariant sweep expects', () => {
    for (const [key, cmd] of Object.entries(HISTORY_COMMANDS)) {
      assert.ok(cmd.name && cmd.en, `${key} needs both names`);
      assert.match(cmd.hex, /^0x[0-9A-F]{4}$/);
      assert.equal(typeof cmd.cmdId, 'number');
      assert.ok(cmd.precondition, `${key} must state what it needs first`);
      assert.ok(['low', 'medium', 'high', 'destructive'].includes(cmd.risk),
        `${key}: risk must be from the canonical set, not prose — a test elsewhere records a `
        + 'bug where prose in this field silently disabled the confirm guard');
      assert.ok(cmd.riskWhy && cmd.riskWhy.length > 30, `${key} must justify its risk`);
      assert.ok(cmd.verified, `${key} must record how it was verified`);
    }
  });

  test('the ids match the commands measured on the build', () => {
    assert.equal(HISTORY_COMMANDS.undo.cmdId, 0xE12B);
    assert.equal(HISTORY_COMMANDS.redo.cmdId, 0xE12C);
    assert.equal(HISTORY_COMMANDS.history.cmdId, 0x8044);
  });

  test('undo and redo are recorded as silent, and history as a dialog', () => {
    // This distinction decides whether a caller needs an accessibility runtime.
    assert.match(HISTORY_COMMANDS.undo.outcome, /silent/i);
    assert.match(HISTORY_COMMANDS.redo.outcome, /silent/i);
    assert.match(HISTORY_COMMANDS.history.outcome, /dialog/i);
  });

  test('undo claims a measured effect and redo does not overclaim', () => {
    // Undo's effect was confirmed from data; redo's reachability was measured but
    // its effect was not independently exercised. The record must keep those apart.
    assert.match(HISTORY_COMMANDS.undo.verified, /MEASURED/);
    assert.match(HISTORY_COMMANDS.undo.verified, /16|8/,
      'the measurement is a note count — say which numbers');
    assert.match(HISTORY_COMMANDS.redo.verified, /not independently|not.*the way undo/i,
      'redo must admit the limit rather than borrowing undo\'s evidence');
  });

  test('the dialog record says rewinding discards work', () => {
    const f = HISTORY_DIALOG.fields;
    assert.equal(f.ok.element, 6);
    assert.match(f.ok.meaning, /DISCARD/i);
    assert.match(HISTORY_DIALOG.listRows, /OLDEST FIRST/i,
      'the ordering is the parse contract for reading the stack');
    assert.equal(f.maxUndo.element, 7);
    assert.match(f.maxUndo.meaning, /dropped/i,
      'the depth limit is why an old rewind may not be possible');
    assert.match(HISTORY_DIALOG.measured, /68|64/, 'record the observed row counts');
  });

  test('the dialog caveat warns that the indices can move', () => {
    // Learned from the CAL run dialog: a shell control appeared between two
    // observations and shifted every index by one.
    assert.match(HISTORY_DIALOG.caveat, /resolve|title|kind/i);
    assert.match(HISTORY_DIALOG.caveat, /move|appear|disappear/i);
  });
});

describe('step() guards run before any process is touched', () => {
  test('an unknown direction is refused with a code', async () => {
    await assert.rejects(() => step('rewind'), (e) => {
      assert.equal(e.code, 'UNKNOWN_DIRECTION');
      assert.match(e.message, /undo/);
      return true;
    });
  });

  test('the wrappers exist and are the same function shape', () => {
    assert.equal(typeof undo, 'function');
    assert.equal(typeof redo, 'function');
    assert.notEqual(undo, redo);
  });
});

describe('historyHelp carries the trap that produced a false negative', () => {
  test('it records the verification mistake rather than only the fix', () => {
    const h = historyHelp();
    // The first attempt compared track names across five undo posts and saw no
    // change — correct, because those entries were track inserts. Recording the
    // mistake is what stops the next reader repeating it.
    assert.match(h.howToVerifyARewind.wrong, /track name/i);
    assert.match(h.howToVerifyARewind.right, /note count|count/i);
    assert.match(h.howToVerifyARewind.problem, /none-observed/i,
      'the success case LOOKS like failure — that is the whole trap');
  });

  test('it says the stack is depth-limited', () => {
    const h = historyHelp();
    assert.ok(h.whyItMatters.some((s) => /128|depth|dropped/i.test(s)),
      'a caller must know an old rewind may already be gone');
  });

  test('it explains that a CAL run is one undoable transaction', () => {
    const h = historyHelp();
    assert.ok(h.whyItMatters.some((s) => /CAL/i.test(s)),
      'rewinding past a CAL edit restores the whole pre-script state, not one note');
  });

  test('it states the limits honestly', () => {
    const h = historyHelp();
    assert.ok(h.limits.length >= 3);
    assert.ok(h.limits.some((l) => /per-operation|rewind to a position|stepping/i.test(l)),
      'there is no per-operation undo, and that must be said');
  });
});
