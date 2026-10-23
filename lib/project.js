// lib/project.js — document-level operations: open, new, save, close, export.
//
// This layer exists because the file commands are the ones that can destroy work,
// and the measurements showed which is which:
//
//   0x80B3  文件 > 新建        opens the 新建工程文件 dialog (JUCE)
//   0xE101  文件 > 打开        opens a standard MFC dialog — fully scriptable
//   0xE103  文件 > 保存        saves in place; writes nothing to the window list
//   0xE104  文件 > 另存为      opens a #32770 dialog
//   0xE102  文件 > 关闭        CLOSES THE DOCUMENT — verified, and it does so with no
//                             prompt when the project is clean
//   0x822B  文件 > 导出 > 音频   needs content and a selection before it will do anything
//   0x8420  文件 > 导入 > MIDI   silent when the target view is not open
//
// The close command is the reason for the guard below: during probing it closed
// the open project without asking, and there was no undo. A tool that can throw
// away unsaved work must say so and require an explicit acknowledgement, the same
// way a destructive shell command does.

import { call } from '../bridge/agent.js';
import { runCommand } from './menu.js';
import { documentState } from './track-ui.js';

/** Every document-level command, with what it does and how dangerous it is. */
export const PROJECT_COMMANDS = {
  newProject: {
    cmdId: 0x80B3, hex: '0x80B3', name: '文件 > 新建', en: 'File > New',
    effect: 'opens the 新建工程文件 dialog (JUCE — needs clicks and typing)',
    risk: 'high', riskWhy: 'replaces the current project; SONAR prompts to save first',
  },
  open: {
    cmdId: 0xE101, hex: '0xE101', name: '文件 > 打开', en: 'File > Open',
    effect: 'opens a standard MFC file dialog, whose filename field accepts AXSetValue',
    risk: 'high', riskWhy: 'replaces the current project; SONAR prompts to save first',
  },
  save: {
    cmdId: 0xE103, hex: '0xE103', name: '文件 > 保存', en: 'File > Save',
    effect: 'saves in place — no dialog and no window change when the file has a path',
    risk: 'low', riskWhy: 'overwrites the file on disk, but that is the point',
  },
  saveAs: {
    cmdId: 0xE104, hex: '0xE104', name: '文件 > 另存为', en: 'File > Save As',
    effect: 'opens a #32770 dialog',
    risk: 'low', riskWhy: 'a new file is written; the original is untouched',
  },
  close: {
    cmdId: 0xE102, hex: '0xE102', name: '文件 > 关闭', en: 'File > Close',
    effect: 'closes the document and returns to Quick Start',
    risk: 'high',
    riskWhy: 'discards the session. Measured: a clean project closes with no prompt at all, so '
      + 'anything unsaved since the last save is gone. There is no undo for this.',
    requiresAcknowledgement: true,
  },
  exportAudio: {
    cmdId: 0x822B, hex: '0x822B', name: '文件 > 导出 > 音频', en: 'File > Export > Audio',
    effect: 'opens the export dialog — but only with content to export; silent otherwise',
    risk: 'low',
    riskWhy: 'writes a new audio file and leaves the project untouched, so nothing is lost — but '
      + 'it needs a selection or a whole-project range first, or it does nothing at all',
  },
  importMidi: {
    cmdId: 0x8420, hex: '0x8420', name: '文件 > 导入 > MIDI', en: 'File > Import > MIDI',
    effect: 'opens MIDI import at the selected track and current time; existing tracks can receive '
      + 'merged clips. Use an empty CWP or open the MIDI as its own document for a new arrangement.',
    risk: 'medium', riskWhy: 'existing target tracks can override imported channels and mix settings. '
      + 'Check the target and time before confirming the file dialog.',
  },
  revert: {
    cmdId: 0x853D, hex: '0x853D', name: '文件 > 恢复', en: 'File > Revert',
    effect: 'reloads from disk, discarding changes',
    risk: 'high', riskWhy: 'silently discards everything since the last save',
    requiresAcknowledgement: true,
    destructive: true,
  },
};

/**
 * Run a document command, refusing the destructive ones unless acknowledged.
 *
 * `confirm` must be the command's own key (e.g. `confirm: 'close'`), not a bare
 * boolean — the point is to make the caller name what it is about to destroy.
 */
export async function projectCommand(key, { confirm, keepOverlays = true } = {}) {
  const cmd = PROJECT_COMMANDS[key];
  if (!cmd) {
    const e = new Error(`unknown project command '${key}'. Known: ${Object.keys(PROJECT_COMMANDS).join(', ')}`);
    e.code = 'UNKNOWN_COMMAND';
    throw e;
  }
  if ((cmd.requiresAcknowledgement || cmd.risk === 'high') && confirm !== key) {
    const e = new Error(
      `${cmd.name} is destructive: ${cmd.riskWhy} `
      + `Pass confirm: '${key}' to proceed, and save first if the work matters.`
    );
    e.code = 'NEEDS_CONFIRMATION';
    e.detail = { command: cmd, currentDocument: await documentState() };
    throw e;
  }

  const before = await documentState();
  // runCommand enforces the same gate for every caller; projectCommand has
  // already checked it, so forward the key it accepted.
  const result = await runCommand(cmd.cmdId, { keepOverlays, confirm: key });
  await new Promise((r) => setTimeout(r, 1200));
  const after = await documentState();

  return {
    ok: true,
    ran: cmd.name,
    cmdId: cmd.cmdId,
    hex: cmd.hex,
    effect: cmd.effect,
    risk: cmd.risk,
    documentBefore: before.projectOpen ? before.project : null,
    documentAfter: after.projectOpen ? after.project : null,
    documentChanged: before.projectOpen !== after.projectOpen
      || before.project !== after.project,
    next: nextStepFor(key, after, result),
  };
}

function nextStepFor(key, after, result) {
  if ((key === 'open' || key === 'newProject') && result.effect !== 'window-change') {
    return 'No new top-level dialog was observed. Inspect the current window and overlays '
      + 'before entering a filename; posting the command alone does not prove a dialog opened.';
  }
  switch (key) {
    case 'open':
      return 'A file dialog should be open. Set its 文件名(N) field with AXSetValue, then click '
        + '打开(O). The field is a standard MFC control, so accessibility writes to it work.';
    case 'newProject':
      return 'The 新建工程文件 dialog is JUCE: its fields carry no accessibility elements, so read '
        + 'the form from a screenshot and click by coordinate. 确定 stays disabled until 位置 '
        + 'exists on disk — create the directory first.';
    case 'importMidi':
      return 'Import reflects the current selection and the current time, not the file alone: '
        + 'with an existing MIDI track selected (or the playhead inside a clip) SONAR merges '
        + 'into it, and that track\'s channels and mixer settings can override the imported ones. '
        + 'For a new arrangement, import into an EMPTY .cwp (new project) or open the .mid as '
        + 'its own document first, then verify with the track/view readback — a silent or '
        + 'stale readback right after the command does not prove the import failed.';
    case 'save':
      return after.projectOpen
        ? 'Saved in place. If the document is still marked modified, the save did not take.'
        : 'Nothing was open to save.';
    case 'close':
      return after.projectOpen
        ? 'The document is still open — the close may have been blocked by a save prompt.'
        : 'Closed. The title should now read "Cakewalk Sonar" with no document.';
    default:
      return undefined;
  }
}

/**
 * A file dialog helper: fill the filename field and press Open.
 *
 * Kept separate from projectCommand because the dialog is a different surface
 * (standard MFC, scriptable) from the command that opened it. A computer-use
 * runtime performs these two steps; this function documents the exact element
 * names so it does not have to rediscover them.
 */
export const FILE_DIALOG = {
  windowClass: '#32770',
  elements: {
    filenameField: 'textfield titled 文件名(N)',
    openButton: 'button titled 打开(O)',
    cancelButton: 'button titled 取消',
    fileTypeCombo: 'combobox titled 文件类型(T)',
  },
  how: [
    'The dialog is standard MFC, so AXSetValue on the filename field works — this is the sharp '
      + 'contrast with SONAR\'s own drawn controls, which do not accept writes.',
    'Set the full path, then click the 打开(O) button by index. Do not type: computer-use key '
      + 'events need SONAR to be frontmost, and a focus-stealing process will refuse them.',
  ],
  measured: 'A two-track MIDI imported into an empty CWP preserved notes, channels, program, '
    + 'CC7/CC10 and GBK Chinese track names in an independently parsed export. Existing target '
    + 'tracks can merge the input and override its routing or mix.',
  gotcha:
    'A whole-MIDI export writes only the selected content (observed: 0xA659), so run '
      + 'cw_navigate selectAll first and then do the full roundtrip, or the file comes out '
      + 'empty or partial. Opening a filename that is already the loaded document does nothing '
      + '— SONAR treats it as already open and skips the reload. Write to a new filename when '
      + 'iterating on a generated file.',
};

/**
 * Turn a documentState() result into the close-safety answer.
 *
 * Exported and pure so the unknown case can be pinned by a test: an imported
 * MIDI document has never been saved as a .cwp, and SONAR marks unsaved changes
 * on the document tab rather than the frame caption. When the tab could not be
 * read, `modified` is null; "unknown" must never become "safe".
 */
export function saveStateFromDocument(doc) {
  // Anything that is not a decidable document state is unsafe to close. An
  // "unknown" here must never be read as "safe": the caller is about to discard
  // unsaved work if it is wrong, and there is no undo for that.
  if (!doc || typeof doc !== 'object' || !doc.known) {
    return {
      known: false,
      safeToClose: false,
      reason: (doc && typeof doc === 'object' ? doc.reason : null)
        || 'The document state could not be read, so unsaved work cannot be ruled out.',
    };
  }
  // A string, a number or a missing flag is not "no project": only the literal
  // boolean false means the frame is empty.
  if (typeof doc.projectOpen !== 'boolean') {
    return {
      known: false,
      safeToClose: false,
      reason: 'The document state did not say whether a project is open, so unsaved work cannot '
        + 'be ruled out.',
    };
  }
  if (doc.projectOpen === false) {
    return {
      known: true, open: false, modified: false, modifiedKnown: true,
      safeToClose: true, note: 'No document is open.',
    };
  }
  // The classifier's own verdict is authoritative: when it says the dirty state
  // is not known (and it did not positively say "modified"), refuse. Only an
  // affirmative clean reading can be safe.
  const modifiedKnown = typeof doc.modified === 'boolean' && doc.modifiedKnown !== false;
  const safeToClose = modifiedKnown ? doc.modified === false : false;
  let note;
  if (!modifiedKnown) {
    note = 'SONAR did not expose the document-tab dirty marker for this document, so unsaved '
      + 'changes cannot be ruled out. The frame caption is not authoritative for imported MIDI. '
      + 'Treat this document as unsafe to close.';
  } else if (doc.modified) {
    note = 'The document tab carries "*", so the project has unsaved changes. Closing or opening '
      + 'another project would prompt — or, if the prompt is dismissed wrongly, lose them.';
  } else {
    note = 'No unsaved changes.';
  }
  return {
    known: true,
    open: true,
    project: doc.project,
    kind: doc.documentKind,
    modified: doc.modified,
    modifiedKnown,
    documentTab: doc.documentTab ?? null,
    safeToClose,
    note,
  };
}

/**
 * What the current document is, in the terms a caller cares about: is there
 * unsaved work, and what would be lost by closing.
 */
export async function saveState() {
  const doc = await documentState();
  return saveStateFromDocument(doc);
}
