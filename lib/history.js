// lib/history.js — undo, redo, and the undo stack itself.
//
// WHY THIS EXISTS
//
// A comparison against two mature MCP surfaces (ACE Studio's 63 tools, the
// After Effects adapter's 36) found this was the single largest capability gap:
// neither of the other two lacks an undo, and this adapter had none. It matters
// more here than elsewhere because half of this adapter's write paths are
// irreversible from the caller's point of view — a CAL run replaces note data,
// a menu command fires with no confirmation, and the project file is binary so
// there is nothing to diff afterwards. Undo is the only backstop, and the
// README already records a session where its absence cost real work ("probing
// closed the open project with no prompt ... and there was no undo").
//
// Undo also turns every uncertain write into a safe one: try it, look at the
// result, rewind if wrong. That changes how an agent can be allowed to work.
//
// THE THREE COMMANDS, ALL MEASURED
//
//   0xE12B  编辑 > 撤销        silent, no dialog — posting the id IS the undo
//   0xE12C  编辑 > 重做        silent, no dialog
//   0x8044  编辑 > 历史(H)     opens a #32770 dialog titled 撤销历史
//
// Undo and redo are in the same class as 倒置 and the nudges: a plain
// WM_COMMAND post with no dialog to drive, so they need no accessibility
// runtime. That makes them the cheapest useful tools in the adapter.
//
// MEASURED 2026-10-15: undo works, and it was verified the hard way. The first
// attempt compared track names before and after five undo posts and concluded
// "no effect" — but the five most recent stack entries were 插入 MIDI 轨, which
// do not touch track names, so no change was the CORRECT result. The second
// attempt counted notes instead: 16 before rewinding to an older entry, 8
// after. The lesson is in the assertion, not the tool: verify a rewind against
// the thing the rewound operation actually changed.
//
// The undo stack is readable, which is unusual and worth using. The 撤销历史
// dialog lists every entry as a row, oldest first, with <start> at the bottom
// and the current position marked. That means a caller can see what is
// reversible before deciding — the one place in this host where the write
// history is legible rather than inferred.

import { documentState } from './track-ui.js';
import { runCommand, listOverlays } from './menu.js';

/** The transport-independent commands this module drives. */
export const HISTORY_COMMANDS = {
  undo: {
    key: 'undo',
    cmdId: 0xE12B, hex: '0xE12B',
    name: '编辑 > 撤销', en: 'Edit > Undo',
    precondition: 'a project open, and something on the undo stack',
    affects: 'reverses the most recent undoable operation',
    outcome: 'silent — no dialog, no window change. Posting the id IS the undo.',
    risk: 'medium',
    riskWhy: 'it discards the most recent change. That is the point, but it is still a discard, '
      + 'and it is itself undoable only by 重做.',
    verified: 'MEASURED 2026-10-15. Posted with no window change (as expected for a drawn-only '
      + 'effect) and confirmed from DATA: a project at 16 notes came back at 8 after rewinding to '
      + 'an older stack entry, and the note count is the thing the rewound edit had changed.',
  },
  redo: {
    key: 'redo',
    cmdId: 0xE12C, hex: '0xE12C',
    name: '编辑 > 重做', en: 'Edit > Redo',
    precondition: 'a project open, and something to redo',
    affects: 'reapplies the operation most recently undone',
    outcome: 'silent — no dialog, no window change',
    risk: 'medium',
    riskWhy: 'it re-applies a change the caller previously undid, which may have been undone '
      + 'precisely because it was wrong.',
    verified: 'MEASURED 2026-10-15 for reachability (posts cleanly, no dialog, no paywall). The '
      + 'EFFECT was not independently confirmed the way undo was — the verification that settled '
      + 'undo used an older stack entry, and redo from that position was not exercised. Treat the '
      + 'post as proven and the effect as expected.',
  },
  history: {
    key: 'history',
    cmdId: 0x8044, hex: '0x8044',
    name: '编辑 > 历史', en: 'Edit > History',
    precondition: 'a project open',
    affects: 'opens the undo stack as a list, where a position can be chosen',
    outcome: 'opens a #32770 dialog titled 撤销历史',
    risk: 'medium',
    riskWhy: 'Reading the stack changes nothing, but choosing an older position and pressing 确定 '
      + 'DISCARDS every operation after it. That step is described separately in openHistory(), '
      + 'and it is the reason driving this dialog is not a casual action.',
    verified: 'MEASURED 2026-10-15. The dialog opened, its rows were read, an entry was chosen '
      + 'and 确定 pressed, and the rewind was confirmed by note count (16 -> 8).',
  },
};

/**
 * The 撤销历史 dialog, as measured.
 *
 * The list is the unusual part: it is not a set of controls but the undo stack
 * itself, one `row` element per entry, oldest first. So a caller can read what
 * is reversible before touching anything — the only place in this host where
 * that is possible.
 *
 * Note what choosing a row means: it is not "undo one step", it is "rewind TO
 * here", discarding every entry after the chosen one. A caller that wants a
 * single step should post 0xE12B instead of driving this dialog.
 */
export const HISTORY_DIALOG = {
  title: '撤销历史',
  openedBy: '0x8044 (编辑 > 历史) with a project open',
  windowClass: '#32770',
  listRows: 'every element of kind "row" is one stack entry, OLDEST FIRST, with "<start>" at the '
    + 'bottom as the oldest position. The current position is the selected row.',
  fields: {
    maxUndo: { label: '最大撤销次数(M):', kind: 'textfield', element: 7, value: '128',
      meaning: 'how deep the stack may go. Once full, the oldest entries are dropped — measured '
        + 'at 128, which a long session of track inserts had already reached, so older edits were '
        + 'no longer recoverable.' },
    ok: { label: '确定', kind: 'button', element: 6,
      meaning: 'rewinds TO the selected entry, DISCARDING everything newer' },
    cancel: { label: '取消', kind: 'button', element: 5 },
    clear: { label: '清除(C)...', kind: 'button', element: 4,
      meaning: 'empties the stack. Destructive and not itself undoable.' },
    help: { label: '帮助', kind: 'button', element: 3 },
  },
  caveat: 'The element indices were measured on one observation and the file dialog has since '
    + 'shown that a shell control can appear or disappear between observations. Resolve the '
    + 'buttons by title and the list by kind rather than trusting these numbers.',
  measured: 'MEASURED 2026-10-15: 68 rows on one observation and 64 on the next (the difference '
    + 'is the stack itself, not the layout). Row 11 held "CAL (forEachEvent)"; choosing it and '
    + 'pressing 確定 rewound the note count from 16 to 8.',
};

/** Guard shared with the rest of the adapter. */
async function requireDocument() {
  const doc = await documentState();
  if (!doc.projectOpen) {
    const e = new Error('No document is open, so there is no 编辑 menu and no history.');
    e.code = 'NO_DOCUMENT';
    throw e;
  }
  return doc;
}

/**
 * A single undo or redo step.
 *
 * Silent by design — the command changes state without opening a window, so a
 * window diff cannot confirm it. The caller is told that plainly rather than
 * being handed a cheerful "ok".
 */
export async function step(direction) {
  const cmd = HISTORY_COMMANDS[direction];
  if (!cmd) {
    const e = new Error(`unknown history direction '${direction}'. Use 'undo' or 'redo'.`);
    e.code = 'UNKNOWN_DIRECTION';
    throw e;
  }
  await requireDocument();
  const posted = await runCommand(cmd.cmdId, {});
  return {
    ok: true,
    did: direction,
    cmdId: cmd.cmdId,
    hex: cmd.hex,
    posted: posted.posted,
    effect: posted.effect,
    newWindows: posted.newWindows,
    confirmed: false,
    evidence: 'This command changes state without opening a window, so this process cannot '
      + 'confirm it. The window list is expected to be unchanged either way — a "none-observed" '
      + 'result here is the SUCCESS case, not a failure. To check that it worked, look at the '
      + 'data the rewind should have restored (a note count, a name, an export), not the screen.',
    expectedVisibleEffect: direction === 'undo'
      ? 'The most recent change disappears from the arrangement.'
      : 'The most recently undone change reappears.',
    howToConfirm: 'Read 编辑 > 历史 (0x8044) and see whether the current position moved, or '
      + 'compare an export against a snapshot taken before the step.',
  };
}

/** Convenience wrappers, because an agent should not have to pass a string. */
export const undo = (opts) => step('undo', opts);
export const redo = (opts) => step('redo', opts);

/**
 * Open the undo-stack dialog and report what is in it.
 *
 * Reading only — this opens the dialog and returns the plan. It does NOT choose
 * a position, because choosing one discards work.
 */
export async function openHistory({ waitMs = 1600 } = {}) {
  await requireDocument();
  const before = await listOverlays();
  await runCommand(HISTORY_COMMANDS.history.cmdId, { keepOverlays: true });
  await new Promise((r) => setTimeout(r, waitMs));
  // Check that a window actually appeared. The old version returned
  // `opened: '撤销历史'` unconditionally, so a swallowed command still claimed
  // the dialog was open.
  const after = await listOverlays();
  const known = (after.overlays || []).map((w) => `${w.cls}|${w.title}`);
  const wasKnown = (before.overlays || []).map((w) => `${w.cls}|${w.title}`);
  const opened = known.some((k) => !wasKnown.includes(k)
    || (k.includes(HISTORY_DIALOG.title) && !wasKnown.includes(k)));
  return {
    ok: true,
    opened: opened ? HISTORY_DIALOG.title : null,
    openedVerified: opened,
    openedNote: opened ? undefined
      : 'No new window appeared, so the dialog probably did not open. A modal may have '
        + 'swallowed the command — check cw_list_overlays and close what is in the way.',
    dialog: HISTORY_DIALOG,
    howToRead: 'Enumerate the dialog and take every element of kind "row". They are the undo '
      + 'stack, oldest first. The selected row is the current position.',
    howToRewind: {
      warning: 'Choosing a row and pressing 确定 is NOT "undo one step" — it rewinds TO that '
        + 'entry and DISCARDS everything newer. For a single step post 0xE12B instead.',
      steps: [
        'Read the rows and pick the index to rewind to.',
        'Click that row.',
        `Press ${HISTORY_DIALOG.fields.ok.label}.`,
        'Verify from data, not from the screen: compare an export or a count against what that '
        + 'position should hold.',
      ],
    },
    howToDiscard: { action: 'press 清除(C)...', warning: 'empties the stack; not itself undoable' },
  };
}

/** Everything about the history layer, for cw_history_help. */
export function historyHelp() {
  return {
    summary:
      'Undo, redo, and a readable undo stack. This is the adapter\'s only rewind, and it is what '
      + 'makes an uncertain write safe: try it, look at the result, rewind if wrong.',
    commands: HISTORY_COMMANDS,
    dialog: HISTORY_DIALOG,
    whyItMatters: [
      'Half the write paths here are irreversible from the caller\'s side — a CAL run replaces '
      + 'note data wholesale, menu commands fire with no confirmation, and the project file is '
      + 'binary so nothing can be diffed afterwards.',
      'The undo stack is DEPTH-LIMITED (最大撤销次数, measured at 128). A long session of track '
      + 'inserts had already exhausted it, so genuinely old edits were no longer recoverable — '
      + 'read the stack before assuming a rewind is still possible.',
      'A CAL run is ONE undoable transaction, not one per note. Rewinding past a CAL edit '
      + 'restores the notes as they were before the whole script ran.',
    ],
    howToVerifyARewind: {
      problem: 'Undo opens no window, so a window diff cannot see it — "none-observed" is the '
        + 'success case, which makes it easy to conclude the opposite.',
      wrong: 'Comparing track names before and after five undo posts. The five newest stack '
        + 'entries were 插入 MIDI 轨, which do not touch track names, so "no change" was correct '
        + 'and the test proved nothing. This mistake was made.',
      right: 'Rewind, then measure the thing the rewound operation actually changed. Settling '
        + 'this used a note count: 16 before, 8 after rewinding to an older entry.',
    },
    limits: [
      'There is no per-operation undo. The stack entries are whole operations, and the dialog '
        + 'rewinds to a position rather than stepping.',
      'This process cannot read which operations are on the stack without opening the dialog; '
        + 'there is no quieter query.',
      'The stack depth is a preference (measured 128) and old entries are dropped silently.',
    ],
  };
}
