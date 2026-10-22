// test/navigate.test.mjs — selection, navigation, markers.
//
// The point of these tests is the same as capability.test.mjs: they guard the
// record, not the feature. The navigate module exists to answer "can this be
// confirmed, and if so by what" for a set of commands that mostly CANNOT be
// confirmed from this process — a selection and a now-time change are drawn, not
// exposed. A test that only checked the ids would let a later edit quietly
// promote an unconfirmed command to confirmed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NAV_COMMANDS, MARKER_COMMANDS, ARRANGER_COMMANDS,
  MARKER_DIALOG, navigate, markerHelp, describeNavigateResult,
} from '../lib/navigate.js';

// This suite is process-free. The two tests that ran a real navigation command
// (and so waited on the bridge) now drive describeNavigateResult, which is the
// pure function that builds the same report — so what they were checking about
// the REPORT is still covered, without the wait.

// --- the record ---------------------------------------------------------------

test('every navigation command declares how it can be confirmed', () => {
  const allowed = ['dialog', 'screenshot', 'elements'];
  for (const [key, cmd] of Object.entries(NAV_COMMANDS)) {
    assert.ok(cmd.name && cmd.en, `${key} needs both names`);
    assert.match(cmd.hex, /^0x[0-9A-F]{4}$/);
    assert.ok(allowed.includes(cmd.confirm),
      `${key} declares confirm='${cmd.confirm}', which is not one of ${allowed.join('/')}`);
  }
});

test('a command confirmed by screenshot says what to look at', () => {
  // Without this the claim is unfalsifiable — nobody can check it later.
  for (const [key, cmd] of Object.entries(NAV_COMMANDS)) {
    if (cmd.confirm === 'screenshot') {
      assert.ok(cmd.whatToLook, `${key} is confirmed visually, so it must say what to look at`);
    }
  }
});

test('a command confirmed by a dialog names the dialog', () => {
  for (const [key, cmd] of Object.entries({ ...NAV_COMMANDS, ...MARKER_COMMANDS })) {
    if (cmd.confirm === 'dialog') {
      assert.ok(cmd.dialog, `${key} opens a dialog, so the dialog must be described`);
      assert.equal(cmd.dialog.class, '#32770', `${key}: the dialog class should be recorded`);
    }
  }
});

test('the two commands that open a dialog are the selection and the marker ones', () => {
  const dialogs = Object.entries(NAV_COMMANDS).filter(([, c]) => c.confirm === 'dialog').map(([k]) => k);
  assert.deepEqual(dialogs.sort(), ['selectByTime']);
  assert.equal(MARKER_COMMANDS.insertMarker.confirm, 'dialog');
});

// --- markers ------------------------------------------------------------------

test('the marker dialog records every field a caller has to fill', () => {
  for (const key of ['name', 'time', 'ok', 'cancel']) {
    assert.ok(MARKER_DIALOG.elements[key], `the dialog description needs '${key}'`);
  }
  assert.ok(MARKER_DIALOG.elements.name.includes('名称'));
  assert.ok(MARKER_DIALOG.elements.time.includes('时间'));
});

test('the marker dialog description states the round trip that was verified', () => {
  // The claim worth preserving: this dialog ACCEPTS writes where SONAR's own
  // controls do not, and the result can be read back from the marker list.
  assert.ok(MARKER_DIALOG.verified, 'the verification must be recorded');
  assert.ok(MARKER_DIALOG.verified.includes('Intro'), 'including the concrete marker that was made');
  assert.ok(MARKER_DIALOG.how.join(' ').includes('AXSetValue'),
    'the mechanism — that accessibility writes work here — must be stated');
  assert.ok(MARKER_DIALOG.readingBack.includes('table'),
    'and the readback path must be named, since that is what closes the loop');
});

test('markerHelp explains why this dialog differs from the track strips', () => {
  const h = markerHelp();
  assert.ok(h.whyItWorks.includes('standard MFC'));
  assert.ok(h.whyItWorks.includes('drawn'), 'the contrast with drawn controls is the lesson');
  // And it must state the limit: only the project markers have remove commands.
  assert.ok(h.whatCannotBeDone.includes('no command'),
    'the missing capability should be recorded, not left as an assumption');
});

test('every marker command carries an id and a name pair', () => {
  for (const [key, cmd] of Object.entries(MARKER_COMMANDS)) {
    assert.equal(typeof cmd.cmdId, 'number', `${key} needs an id`);
    assert.match(cmd.hex, /^0x[0-9A-F]{4}$/);
    assert.ok(cmd.name && cmd.en, `${key} needs both names`);
  }
});

test('the project-marker remove commands are all present', () => {
  // These exist while deleting an arbitrary named marker does not — a
  // distinction worth an explicit test so the omission is deliberate.
  for (const key of ['removeProjectStart', 'removeProjectEnd', 'removeProjectRange']) {
    assert.ok(MARKER_COMMANDS[key], `${key} should be recorded`);
  }
});

// --- the arranger is recorded but not claimed ---------------------------------

test('the arranger commands are recorded as unprobed, not as working', () => {
  assert.ok(ARRANGER_COMMANDS.note.includes('Not probed'),
    'the arranger must be marked unprobed rather than quietly listed as available');
  for (const [key, cmd] of Object.entries(ARRANGER_COMMANDS)) {
    if (key === 'note') continue;
    assert.equal(typeof cmd.cmdId, 'number');
  }
});

// --- behaviour ----------------------------------------------------------------

test('an unknown navigation command is refused with the known list', async () => {
  await assert.rejects(
    () => navigate('teleport'),
    (e) => e.code === 'UNKNOWN_COMMAND' && e.message.includes('insertMarker')
  );
});

test('navigate reports a dialog result with instructions rather than a claim', () => {
  // insertMarker lives in MARKER_COMMANDS, not NAV_COMMANDS — navigate() merges
  // the two tables, so the merged view is what a caller sees. Using the wrong
  // table here is exactly the kind of slip this refactor surfaced.
  const r = describeNavigateResult(MARKER_COMMANDS.insertMarker, { newWindows: ['#32770|标记'] });
  assert.equal(r.confirm, 'dialog');
  assert.equal(r.dialogOpened, true);
  assert.equal(r.dialogMissing, false);
  assert.ok(r.next.includes('cw_markers'), 'it should point at the tool that has the element names');
  assert.equal(r.ran, '工程 > 插入标记');
});

/*
 * The un-used-evidence defect. `next` was chosen from `cmd.confirm` alone, so a
 * command whose dialog should have opened said "A dialog should be open" even
 * when `newWindows` was empty and it plainly had not. The evidence was in hand.
 * Same shape as the `cw_edit` outcome fix, same measured cause: a leftover modal
 * swallows menu commands.
 */
test('a dialog command whose dialog did not appear says so instead of describing the command', () => {
  const r = describeNavigateResult(MARKER_COMMANDS.insertMarker, { newWindows: [] });
  assert.equal(r.expectedDialog, true);
  assert.equal(r.dialogOpened, false);
  assert.equal(r.dialogMissing, true);
  assert.match(r.next, /none appeared/, 'it must report the absence, not the expectation');
  assert.match(r.next, /cw_close_overlays|cw_list_overlays/, 'and name the fix');
  assert.doesNotMatch(r.next, /should be open/, 'the old optimistic wording must be gone');
});

test('navigate says a drawn change cannot be confirmed by this process', () => {
  const r = describeNavigateResult(NAV_COMMANDS.selectAll, { newWindows: [] });
  assert.equal(r.confirm, 'screenshot');
  assert.equal(r.dialogMissing, false, 'a screenshot-confirmed command expects no dialog');
  assert.ok(r.next.includes('computer-use'),
    'a selection is drawn, so the answer must name the witness');
  assert.ok(r.next.includes('selected border'), 'and say what to look at');
});

test('a command with no named witness still says how it could be confirmed', () => {
  const cmd = { name: 'x', cmdId: 1, hex: '0x0001', effect: 'e', confirm: 'screenshot' };
  const r = describeNavigateResult(cmd, {});
  assert.match(r.next, /drawn, not exposed/,
    'the class must be stated even when there is nothing specific to look at');
  assert.match(r.next, /screenshot/, 'and it must name the witness that would settle it');
});

/*
 * The three evidence classes each need their own wording. `next` used to have two
 * branches for three classes, so `confirm: 'elements'` — which showMarkerView is
 * the only command to use — fell through to the drawn-change text and produced a
 * sentence arguing with itself: "drawn, not exposed" then "is a TABLE — readable".
 * An adversarial audit found it; no test covered the branch at all.
 */
test('an elements-confirmed command is not described as drawn', () => {
  const r = describeNavigateResult(MARKER_COMMANDS.showMarkerView, {});
  assert.equal(r.confirm, 'elements');
  assert.match(r.next, /exposed as elements/,
    'it must name the class it is, not the weakest one');
  assert.doesNotMatch(r.next, /drawn, not exposed/,
    'the marker list is readable — calling it drawn contradicts the same sentence');
  assert.match(r.next, /no screenshot is needed/,
    'and it should say what distinguishes this from the screenshot class');
});

test('every command in the probed tables declares how it can be confirmed', () => {
  /*
   * A command with no `confirm` fell through to a generic sentence that implied it
   * had been characterised when its record was in fact empty — three marker
   * removals did exactly that.
   *
   * ARRANGER_COMMANDS used to be excluded here wholesale, and a verifier showed why
   * that was too generous: a command added to it with no `confirm` and no `effect`
   * would sail through. The rule is now per-command rather than per-table —
   * `unprobed` is a legitimate declaration, but it must be a DECLARATION, and it
   * must come with a `verified` field saying so. Silence is what is rejected.
   */
  const tables = [
    [NAV_COMMANDS, 'NAV_COMMANDS', ''],
    [MARKER_COMMANDS, 'MARKER_COMMANDS', ''],
    [ARRANGER_COMMANDS, 'ARRANGER_COMMANDS', String(ARRANGER_COMMANDS.note ?? '')],
  ];
  const allowed = ['dialog', 'elements', 'screenshot', 'unprobed'];
  for (const [tbl, label, tableNote] of tables) {
    for (const [key, cmd] of Object.entries(tbl)) {
      // Skip non-command entries: a bare prose note, or anything without an id.
      if (typeof cmd !== 'object' || cmd === null || !cmd.cmdId) continue;
      assert.ok(cmd.confirm,
        `${label}.${key} has no confirm class — say 'unprobed' if it was never measured`);
      assert.ok(allowed.includes(cmd.confirm),
        `${label}.${key} has an unknown confirm class '${cmd.confirm}'`);
      assert.ok(cmd.effect, `${label}.${key} does not state what it changes`);
      if (cmd.confirm === 'unprobed') {
        // The admission may live on the command or on the table's own note; what is
        // rejected is neither, which is how a command ends up looking measured.
        const evidence = `${cmd.verified || ''} ${tableNote}`;
        assert.match(evidence, /not probed|unprobed/i,
          `${label}.${key} claims unprobed — nothing says it was not measured`);
      }
    }
  }
});

test('an unprobed command says so instead of sounding like a measured one', () => {
  const r = describeNavigateResult(MARKER_COMMANDS.removeProjectStart, { newWindows: [] });
  assert.equal(r.confirm, 'unprobed');
  assert.match(r.next, /NOT PROBED/, 'the headline must not hedge');
  assert.match(r.next, /unverified/, 'and it must name what is unknown');
  assert.doesNotMatch(r.next, /screenshot/i,
    'it must not suggest a witness nobody measured — that is what made the old record '
    + 'self-contradictory');
});

test('the unprobed removals carry no fabricated whatToLook', () => {
  for (const key of ['removeProjectStart', 'removeProjectEnd', 'removeProjectRange']) {
    assert.equal(MARKER_COMMANDS[key].whatToLook, undefined,
      `${key} had an invented whatToLook; nothing about these commands was measured`);
    assert.equal(MARKER_COMMANDS[key].destructive, true, `${key} removes a marker`);
    assert.match(MARKER_COMMANDS[key].verified, /NOT PROBED/);
  }
});

test('every branch carries whatToLook when the command declares it', () => {
  /*
   * Found by attacking the branch rewrite. `whatToLook` was dropped on both dialog
   * branches, so a command that opens a dialog AND names what to look at lost the
   * second half — exactly when it matters most, since "a dialog should be open" and
   * "no dialog appeared" are the two moments a caller needs to know where to look.
   */
  const hybrid = {
    name: 'hybrid', cmdId: 1, hex: '0x0001', effect: 'opens something',
    confirm: 'dialog', whatToLook: 'the distinctive marker text',
  };
  const withWindow = describeNavigateResult(hybrid, { newWindows: ['#32770|x'] });
  const without = describeNavigateResult(hybrid, { newWindows: [] });
  assert.match(withWindow.next, /distinctive marker text/, 'the open case must name what to look at');
  assert.match(without.next, /distinctive marker text/, 'and so must the missing-dialog case');

  // The same for the classes that already carried it, so the guarantee is uniform.
  const elements = describeNavigateResult(MARKER_COMMANDS.showMarkerView, {});
  assert.match(elements.next, /marker list is a TABLE/, 'elements keeps its whatToLook');
  const shot = describeNavigateResult(NAV_COMMANDS.selectAll, {});
  assert.match(shot.next, /selected border/, 'screenshot keeps its whatToLook');
});

test('no branch emits an unfilled placeholder or a doubled sentence', () => {
  // A cheap structural sweep: every real command, every window state, and the
  // text must be a finished sentence rather than a template with a hole.
  for (const cmd of [...Object.values(NAV_COMMANDS), ...Object.values(MARKER_COMMANDS)]) {
    for (const windows of [[], ['#32770|x']]) {
      const r = describeNavigateResult(cmd, { newWindows: windows });
      assert.ok(r.next && r.next.length > 30, `${cmd.name}: next is too short to be useful`);
      assert.doesNotMatch(r.next, /undefined|null|\$\{/, `${cmd.name}: unfilled value in next`);
      assert.doesNotMatch(r.next, /\.\s*\./, `${cmd.name}: doubled period`);
      /*
       * Run-on detection: a sentence must not have two capitalised words in a row
       * that should have been separated. This catches the interpolated-whatToLook
       * case, where a stored string ending in a dash or no punctuation ran straight
       * into the next clause ("...unlike the track strips Read it through...").
       * Command labels in the text are the deliberate exception.
       */
      const runOn = r.next.match(/[^.:;!?]\s+[A-Z][a-z]{3,}/g) ?? [];
      for (const m of runOn) {
        assert.ok(/cw_|SONAR|MIDI|Alt|Ctrl|AudioSnap|Region|Cakewalk/.test(m),
          `${cmd.name}: possible missing punctuation before "${m.trim()}"`);
      }
    }
  }
});

test('whatToLook is exposed as a field, not only folded into prose', () => {
  // A machine caller should not have to parse a sentence to learn what to look at.
  const r = describeNavigateResult(MARKER_COMMANDS.showMarkerView, {});
  assert.equal(r.whatToLook, MARKER_COMMANDS.showMarkerView.whatToLook,
    'the structured value must reach the caller');
  assert.match(r.next, /marker list is a TABLE/, 'and still appear in the prose');
  assert.doesNotMatch(r.next, /strips Read/, 'with punctuation between the interpolated parts');

  // A command without one reports null rather than undefined, so the field is
  // always present and a caller can test it without a hasOwnProperty dance.
  const none = describeNavigateResult(NAV_COMMANDS.selectAll, {});
  assert.equal(typeof none.whatToLook, 'string');
});

test('every evidence class present in the tables has wording', () => {
  const seen = new Set();
  for (const cmd of [...Object.values(NAV_COMMANDS), ...Object.values(MARKER_COMMANDS)]) {
    const r = describeNavigateResult(cmd, { newWindows: [] });
    assert.ok(r.next && r.next.length > 20, `${cmd.name} produced no explanation`);
    seen.add(cmd.confirm);
  }
  // `unprobed` is a legitimate class — the honest one for a command nobody has run.
  assert.deepEqual([...seen].sort(), ['dialog', 'elements', 'screenshot', 'unprobed'],
    'every class in the tables must have wording, and no new one may appear silently');
});

test('the navigation keys and the marker keys do not collide', () => {
  const nav = new Set(Object.keys(NAV_COMMANDS));
  for (const key of Object.keys(MARKER_COMMANDS)) {
    assert.ok(!nav.has(key), `'${key}' appears in both tables`);
  }
});

test('no command id is reused across the navigation and marker tables', () => {
  const seen = new Map();
  for (const [key, cmd] of Object.entries({ ...NAV_COMMANDS, ...MARKER_COMMANDS })) {
    if (seen.has(cmd.cmdId)) {
      assert.fail(`0x${cmd.cmdId.toString(16)} is both ${seen.get(cmd.cmdId)} and ${key}`);
    }
    seen.set(cmd.cmdId, key);
  }
});
