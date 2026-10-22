// test/capability.test.mjs — the guard rails and the honest-reporting layers.
//
// Three modules are tested here, and all three exist to prevent a specific
// mistake rather than to add a feature:
//
//   project.js    — a destructive command must not run without being named.
//                   During probing, 文件 > 关闭 closed the open project with no
//                   prompt, and there was no undo.
//   verify.js     — "nothing errored" must not be reported as success. A toggle
//                   or a transport action opens no window, so a window diff sees
//                   nothing; calling that a failure is what made an earlier round
//                   declare working commands unhandled.
//   transport.js  — every command changes state invisibly, so the result has to
//                   say so and name what a human or runtime should look at.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_COMMANDS, projectCommand, saveState, FILE_DIALOG,
} from '../lib/project.js';
import {
  COMMAND_EVIDENCE, COMMAND_KINDS, EVIDENCE, evidenceSummary, runAndClassify,
} from '../lib/verify.js';
import {
  TRANSPORT_COMMANDS, transportCommand, TEMPO_RECIPES, timingState, TRANSPORT_EVIDENCE,
} from '../lib/transport.js';
import { shutdownShims } from './helpers.mjs';

test.after(async () => { await shutdownShims(); });

// --- the destructive-command guard -------------------------------------------

test('every project command declares a risk level and a reason for it', () => {
  for (const [key, cmd] of Object.entries(PROJECT_COMMANDS)) {
    assert.ok(['low', 'medium', 'high'].includes(cmd.risk), `${key} needs a risk level`);
    assert.ok(cmd.riskWhy && cmd.riskWhy.length > 20, `${key} needs a reason, not just a label`);
    assert.equal(typeof cmd.cmdId, 'number');
    assert.match(cmd.hex, /^0x[0-9A-F]{4}$/);
  }
});

test('the commands that discard work require an acknowledgement', () => {
  for (const key of ['close', 'revert']) {
    assert.equal(PROJECT_COMMANDS[key].requiresAcknowledgement, true,
      `${key} discards the session, so it must require confirmation`);
  }
  // Saving is not destructive in the sense that matters here.
  assert.notEqual(PROJECT_COMMANDS.save.requiresAcknowledgement, true);
  assert.notEqual(PROJECT_COMMANDS.saveAs.requiresAcknowledgement, true);
});

test('a destructive command is refused without the matching confirm value', async () => {
  for (const key of ['close', 'revert']) {
    await assert.rejects(
      () => projectCommand(key),
      (e) => e.code === 'NEEDS_CONFIRMATION',
      `${key} must refuse without confirmation`
    );
  }
});

test('a bare boolean is not accepted as confirmation', async () => {
  // The point of requiring the command's own key is that the caller has to name
  // what it is destroying. `true` would defeat that.
  await assert.rejects(
    () => projectCommand('close', { confirm: true }),
    (e) => e.code === 'NEEDS_CONFIRMATION'
  );
  await assert.rejects(
    () => projectCommand('close', { confirm: 'yes' }),
    (e) => e.code === 'NEEDS_CONFIRMATION'
  );
});

test('the refusal carries the current document so the caller can see what is at stake', async () => {
  try {
    await projectCommand('close');
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'NEEDS_CONFIRMATION');
    assert.ok(e.detail, 'the error should carry context');
    assert.ok('currentDocument' in e.detail);
    assert.ok(e.message.includes('confirm'), 'the message should say how to proceed');
  }
});

test('an unknown project command is refused with the known list', async () => {
  await assert.rejects(
    () => projectCommand('format-c-drive'),
    (e) => e.code === 'UNKNOWN_COMMAND' && e.message.includes('newProject')
  );
});

test('saveState reports the modified flag rather than guessing', async () => {
  const s = await saveState();
  if (!s.known) return;
  if (!s.open) {
    assert.equal(s.safeToClose, true);
    return;
  }
  assert.equal(typeof s.modified, 'boolean');
  assert.equal(s.safeToClose, !s.modified, 'safeToClose must follow from modified');
  assert.ok(s.note);
});

// --- file dialog documentation ------------------------------------------------

test('the file dialog helper names the elements a caller must find', () => {
  assert.equal(FILE_DIALOG.windowClass, '#32770', 'the standard MFC dialog class');
  assert.ok(FILE_DIALOG.elements.filenameField.includes('文件名'));
  assert.ok(FILE_DIALOG.elements.openButton.includes('打开'));
  assert.ok(FILE_DIALOG.how.length > 0);
  // The single most useful fact about this dialog, and the one that took longest
  // to establish: it accepts writes where SONAR's own controls do not.
  assert.ok(FILE_DIALOG.how.join(' ').includes('AXSetValue'));
  assert.ok(FILE_DIALOG.gotcha.includes('already'), 'the same-name reload trap must be recorded');
});

// --- honest reporting ---------------------------------------------------------

test('every classified command declares what kind of change it makes', () => {
  for (const c of COMMAND_EVIDENCE) {
    assert.ok(COMMAND_KINDS[c.kind], `${c.name} has unknown kind '${c.kind}'`);
    assert.equal(typeof c.confirmed, 'boolean', `${c.name} needs a confirmed flag`);
    assert.match(c.hex, /^0x[0-9A-F]{4}$/);
  }
});

test('the evidence classes are distinct, and every kind cites only known ones', () => {
  // The old version asserted that four string literals were strings — it could not
  // fail and tested no ordering at all. An adversarial audit flagged it. What is
  // actually load-bearing: the classes are distinct (a duplicate would silently
  // merge two evidence levels into one), and no command kind cites a class that
  // does not exist.
  const declared = Object.values(EVIDENCE);
  assert.equal(declared.length, new Set(declared).size,
    'two evidence classes share a value, so no caller can tell them apart');
  const known = new Set(declared);
  for (const [kind, spec] of Object.entries(COMMAND_KINDS)) {
    assert.ok(spec.evidence.length > 0, `COMMAND_KINDS.${kind} cites no evidence at all`);
    for (const e of spec.evidence) {
      assert.ok(known.has(e), `COMMAND_KINDS.${kind} cites unknown evidence '${e}'`);
    }
  }
});

test('a command that opens a dialog expects window evidence, a toggle does not', () => {
  assert.deepEqual(COMMAND_KINDS.opensDialog.evidence, [EVIDENCE.WINDOW]);
  // A toggle cannot be confirmed by a window appearing, because none will.
  assert.ok(!COMMAND_KINDS.toggles.evidence.includes(EVIDENCE.WINDOW));
  assert.ok(!COMMAND_KINDS.transport.evidence.includes(EVIDENCE.WINDOW));
});

test('every confirmed command in the record has a note or is self-evident', () => {
  const needingNote = COMMAND_EVIDENCE.filter(
    (c) => c.confirmed && !COMMAND_KINDS[c.kind].evidence.includes(EVIDENCE.WINDOW)
  );
  // These were confirmed by something other than a window, so the note is what
  // tells a later reader how — losing it would make the claim unfalsifiable.
  for (const c of needingNote) {
    assert.ok(c.note, `${c.name} was confirmed without a window, so it needs a note saying how`);
  }
});

test('evidenceSummary separates confirmed from unconfirmed and explains the difference', () => {
  const s = evidenceSummary();
  assert.equal(s.total, COMMAND_EVIDENCE.length);
  assert.equal(s.confirmed + s.unconfirmed, s.total);
  assert.ok(s.confirmed > 0 && s.unconfirmed > 0, 'both groups should be non-empty');
  assert.ok(s.reading.includes('does not mean broken'),
    'the summary must not let "unconfirmed" read as "broken"');
  assert.ok(s.lesson.includes('artefact'), 'the lesson from the earlier mistake must survive');
});

test('runAndClassify does not claim success from "nothing errored"', async () => {
  // Ask it to classify a command id that is in the record as a toggle. Whatever
  // the live state, the result must never be a bare "confirmed" without evidence.
  const r = await runAndClassify(0x80B9);
  // 'not-posted' is the honest answer when the transport itself is unavailable
  // (no SONAR, no readable menu); it must never be reported as did-nothing.
  assert.ok(['confirmed', 'did-nothing', 'unconfirmed', 'not-posted'].includes(r.status));
  if (r.status === 'not-posted') assert.ok(r.error, 'a not-posted result must carry the reason');
  if (r.status === 'unconfirmed') {
    assert.ok(r.wouldConfirmWith, 'an unconfirmed result must say what would settle it');
    assert.ok(r.wouldConfirmWith.includes('computer-use'));
  }
  if (r.status === 'confirmed') {
    assert.equal(r.evidenceUsed, EVIDENCE.WINDOW,
      'this process can only confirm a command by seeing a window');
  }
});

test('runAndClassify names the command it ran', async () => {
  const r = await runAndClassify(0x882D);
  assert.equal(r.hex, '0x882D');
  assert.equal(r.name, '编辑 > 参数设置');
  assert.equal(r.kind, 'opensDialog');
});

// --- transport ---------------------------------------------------------------

test('every transport command carries an id and both names', () => {
  for (const [key, cmd] of Object.entries(TRANSPORT_COMMANDS)) {
    assert.equal(typeof cmd.cmdId, 'number', `${key} needs an id`);
    assert.match(cmd.hex, /^0x[0-9A-F]{4}$/);
    assert.ok(cmd.name, `${key} needs a Chinese name`);
    assert.ok(cmd.en, `${key} needs an English name`);
  }
});

test('the transport evidence note says these cannot be confirmed from here', () => {
  assert.ok(TRANSPORT_EVIDENCE.includes('cannot confirm'),
    'the note must be explicit that posting is not confirming');
  assert.ok(TRANSPORT_EVIDENCE.includes('computer-use'),
    'and must name the witness that would confirm');
});

test('an unknown transport command is refused with the known list', async () => {
  await assert.rejects(
    () => transportCommand('warp-speed'),
    (e) => e.code === 'UNKNOWN_COMMAND' && e.message.includes('showTempoView')
  );
});

test('a transport command reports intent, not accomplishment', async () => {
  // Two legitimate paths, and the test must accept both. With no project open the
  // 工程 menu is absent from the menu bar entirely, so the honest answer is
  // NO_DOCUMENT — that is the module working, not failing. The contract under test
  // (report intent, never claim accomplishment) holds on both paths.
  let r = null;
  try {
    r = await transportCommand('showTempoView');
  } catch (e) {
    assert.equal(e.code, 'NO_DOCUMENT', `unexpected failure: ${e.message}`);
    return;
  }
  assert.equal(r.confirmed, false, 'this process cannot confirm a view switch');
  assert.ok(r.expectedVisibleEffect, 'it must say what to look at');
  assert.ok(r.evidence);
  assert.equal(r.posted, '视图 > 速度');
});

test('the tempo recipes distinguish the file route from the command route', () => {
  assert.ok(TEMPO_RECIPES.viaFile.verified, 'the file route is the verified one');
  assert.ok(TEMPO_RECIPES.viaCommand.caveat, 'the command route has a caveat worth stating');
  assert.ok(TEMPO_RECIPES.viaFile.caveat.includes('already'),
    'the same-name reload trap applies here too');
});

test('timingState admits it cannot read the timing values', async () => {
  const s = await timingState();
  assert.equal(s.readableFromHere, false);
  assert.ok(s.howToRead, 'it must say how to get them instead');
  // Both routes out: a screenshot, or the file the adapter wrote.
  assert.ok(s.howToRead.includes('computer-use') || s.howToRead.includes('cw_read_midi_file'));
});

// --- cross-module consistency -------------------------------------------------

test('no command id is claimed by two different capability records', () => {
  // The project and transport records are separate; the same id appearing in both
  // with different meanings would be a documentation bug that misleads a caller.
  const projectIds = new Map(Object.entries(PROJECT_COMMANDS).map(([k, v]) => [v.cmdId, k]));
  for (const [key, cmd] of Object.entries(TRANSPORT_COMMANDS)) {
    if (projectIds.has(cmd.cmdId)) {
      assert.fail(`0x${cmd.cmdId.toString(16)} is both transport.${key} and project.${projectIds.get(cmd.cmdId)}`);
    }
  }
});

test('the evidence record covers the commands the other modules expose', () => {
  const recorded = new Set(COMMAND_EVIDENCE.map((c) => c.cmdId));
  // The transport commands are the ones most easily misread as broken, so they
  // must appear in the record rather than only in the transport table.
  for (const key of ['play', 'stop', 'record', 'toggleLoop', 'showTempoView']) {
    assert.ok(recorded.has(TRANSPORT_COMMANDS[key].cmdId),
      `${key} should be in the evidence record`);
  }
});
