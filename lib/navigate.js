// lib/navigate.js — selection, navigation, markers and the arranger.
//
// This is the largest coverage gap that turned out to be genuinely usable, and
// the usable part is narrower than the command list suggests. Probing 16
// selection/navigation/marker commands produced a clean three-way split:
//
//   opens a readable dialog  — a real capability
//     0x804F 编辑 > 选择 > 按时间        opens #32770 「按时间选择」
//     0x807F 工程 > 插入标记             opens #32770 「标记」
//
//   fires silently            — real, but with nothing to read back
//     0x804C 选择全部  0x804D 取消选择  0x8050 从当前位置  0x8051 到当前位置
//     0xA720 设置项目开始标记  0xA71E 设置项目结束标记  0xA61E/A61F 上下小节
//     0x8037/0x8038 前后标记
//     A selection or a now-time change is DRAWN — the ruler shows it, the
//     accessibility tree does not. Same shape of limitation as the track strips.
//
//   changes what is on screen
//     0x803A 视图 > 标记     the marker list appears as a table — and a table is
//                           readable, which is how a created marker was confirmed
//
// The marker dialog is the find of this round. It is standard MFC, so unlike
// SONAR's own controls its fields accept AXSetValue: a marker was created by
// setting 名称 and 时间 and pressing 确定, and the result was then read back from
// the marker list. That is a full round trip — write through a dialog, read
// through a table — and it is the pattern to reach for whenever a drawn surface
// has a command that opens a dialog behind it.

import { call } from '../bridge/agent.js';
import { runCommand } from './menu.js';
import { documentState } from './track-ui.js';

/** Selection and navigation commands, with what can be confirmed about each. */
export const NAV_COMMANDS = {
  selectAll: {
    cmdId: 0x804C, hex: '0x804C', name: '编辑 > 选择 > 全部', en: 'Select All',
    effect: 'selects every clip', confirm: 'screenshot',
    whatToLook: 'every clip in the track area shows its selected border',
  },
  selectNone: {
    cmdId: 0x804D, hex: '0x804D', name: '编辑 > 选择 > 取消', en: 'Select None',
    effect: 'clears the selection', confirm: 'screenshot',
    whatToLook: 'no clip shows a selected border',
  },
  selectByTime: {
    cmdId: 0x804F, hex: '0x804F', name: '编辑 > 选择 > 按时间', en: 'Select by Time',
    effect: 'opens the 按时间选择 dialog', confirm: 'dialog',
    dialog: { class: '#32770', title: '按时间选择',
      fields: 'from/to time fields, and a track-scope choice' },
  },
  selectFromNow: {
    cmdId: 0x8050, hex: '0x8050', name: '编辑 > 选择 > 从当前位置', en: 'Select from Now',
    effect: 'selects from the now-time onward', confirm: 'screenshot',
    whatToLook: 'the selection highlight starts at the now-time',
  },
  selectToNow: {
    cmdId: 0x8051, hex: '0x8051', name: '编辑 > 选择 > 到当前位置', en: 'Select to Now',
    effect: 'selects up to the now-time', confirm: 'screenshot',
    whatToLook: 'the selection highlight runs from the start of the project up to the now-time',
  },
  selectToEnd: {
    cmdId: 0x8053, hex: '0x8053', name: '编辑 > 选择 > 到结束位置', en: 'Select to End',
    effect: 'selects to the end of the project', confirm: 'screenshot',
    whatToLook: 'the selection highlight runs from the start of the project to the last event',
  },
  goToNextMeasure: {
    cmdId: 0xA61E, hex: '0xA61E', name: '转到下一个小节', en: 'Go to next measure',
    // Measured: the call returns ok while the now-time readout does not move, and
    // the id is NOT in the live 257-entry menu. Claiming "moves the now-time" was
    // a success-shaped lie; the honest statement is that the command is posted and
    // the result is not observable from this process.
    effect: 'posts the 转到下一个小节 command; the transport position cannot be read from this '
      + 'process, so whether the now-time moved is UNVERIFIED', confirm: 'screenshot',
    whatToLook: 'the now-time readout in the transport bar advances a bar (a computer-use runtime '
      + 'must look — cw_navigate cannot see it)',
  },
  goToPrevMeasure: {
    cmdId: 0xA61F, hex: '0xA61F', name: '转到上一个小节', en: 'Go to previous measure',
    effect: 'posts the 转到上一个小节 command; the transport position cannot be read from this '
      + 'process, so whether the now-time moved is UNVERIFIED', confirm: 'screenshot',
    whatToLook: 'the now-time readout in the transport bar goes back one bar (a computer-use runtime '
      + 'must look — cw_navigate cannot see it)',
  },
  goToPrevMarker: {
    cmdId: 0x8037, hex: '0x8037', name: '前一标记', en: 'Previous marker',
    effect: 'posts the 前一标记 command; the transport position cannot be read from this '
      + 'process, so whether the now-time moved is UNVERIFIED', confirm: 'screenshot',
    whatToLook: 'the now-time lands on the bar of the preceding marker, and that marker '
      + 'highlights (a computer-use runtime must look — cw_navigate cannot see it)',
  },
  goToNextMarker: {
    cmdId: 0x8038, hex: '0x8038', name: '下一标记', en: 'Next marker',
    effect: 'posts the 后一标记 command; the transport position cannot be read from this '
      + 'process, so whether the now-time moved is UNVERIFIED', confirm: 'screenshot',
    whatToLook: 'the now-time lands on the bar of the following marker (a computer-use '
      + 'runtime must look — cw_navigate cannot see it)',
  },
};

/** Marker commands. The ones that matter are the start/end project markers. */
export const MARKER_COMMANDS = {
  insertMarker: {
    cmdId: 0x807F, hex: '0x807F', name: '工程 > 插入标记', en: 'Insert Marker',
    effect: 'opens the 标记 dialog', confirm: 'dialog',
    dialog: { class: '#32770', title: '标记',
      fields: '名称(N): the marker name, 时间(T): a Bars|Beats position, 锁定至 SMPTE 时间(L): a '
        + 'checkbox, 律动剪辑音高变更(P): a combobox — then 确定 / 取消 / 帮助' },
    verified: 'a marker named "Intro" at 1:01:000 was created by writing 名称 and 时间 and '
      + 'pressing 确定; the marker then appeared on the ruler and in the marker list',
  },
  setProjectStart: {
    cmdId: 0xA720, hex: '0xA720', name: '将项目开始标记设置为当前时间', en: 'Set project start marker',
    effect: 'sets the project start to the now-time', confirm: 'screenshot',
  },
  setProjectEnd: {
    cmdId: 0xA71E, hex: '0xA71E', name: '将项目结束标记设置为当前时间', en: 'Set project end marker',
    effect: 'sets the project end to the now-time', confirm: 'screenshot',
  },
  setProjectRange: {
    cmdId: 0xA722, hex: '0xA722', name: '将项目开始/结束标记设置为选区', en: 'Set project range from selection',
    effect: 'bounds the project by the current selection', confirm: 'screenshot',
  },
  toggleProjectMarkers: {
    cmdId: 0xA788, hex: '0xA788', name: '启用项目开始/结束标记', en: 'Enable project markers',
    effect: 'toggles whether the start/end markers are enforced', confirm: 'screenshot',
  },
  /*
   * The three project-marker removals. Recorded with an id and a name and NOTHING
   * measured — and that is now stated rather than dressed up.
   *
   * An earlier version of these entries gave them `confirm: 'screenshot'` and a
   * `whatToLook` sentence, which a verifier correctly called fabricated: the same
   * record said "not probed" and then supplied the answer probing would have
   * produced. Inventing a plausible witness for an unmeasured command is worse than
   * admitting the gap, because it reads as knowledge.
   *
   * So `confirm: 'unprobed'` routes them to the fallback branch, which says the
   * record does not know how they can be confirmed. `destructive: true` is not a
   * measurement either — it follows from the name — but it is a claim about what
   * the command IS rather than about what was observed, and it is the safe
   * direction to be wrong in.
   */
  removeProjectStart: {
    cmdId: 0xA723, hex: '0xA723', name: '移除项目开始标记', en: 'Remove start marker',
    effect: 'stated by the menu only — removes the project start marker',
    confirm: 'unprobed',
    destructive: true,
    verified: 'NOT PROBED. The id and name come from the live menu; nothing about what it does or '
      + 'how to confirm it has been measured. Only the two 插入标记 paths were. Treat this command '
      + 'as unknown, not as known-inert.',
  },
  removeProjectEnd: {
    cmdId: 0xA724, hex: '0xA724', name: '移除项目结束标记', en: 'Remove end marker',
    effect: 'stated by the menu only — removes the project end marker',
    confirm: 'unprobed',
    destructive: true,
    verified: 'NOT PROBED — see removeProjectStart.',
  },
  removeProjectRange: {
    cmdId: 0xA725, hex: '0xA725', name: '移除项目开始/结束标记', en: 'Remove both',
    effect: 'stated by the menu only — removes both project markers',
    confirm: 'unprobed',
    destructive: true,
    verified: 'NOT PROBED — see removeProjectStart.',
  },
  showMarkerView: {
    cmdId: 0x803A, hex: '0x803A', name: '视图 > 标记', en: 'Views > Markers',
    effect: 'shows the marker list', confirm: 'elements',
    whatToLook: 'the marker list is a TABLE — readable, unlike the track strips',
  },
};

/**
 * The marker dialog's element names.
 *
 * Worth spelling out because it is the working pattern for anything drawn: find
 * a command that opens an MFC dialog, and the dialog is scriptable where the
 * drawn surface is not.
 */
export const MARKER_DIALOG = {
  windowClass: '#32770',
  title: '标记',
  elements: {
    name: 'textfield titled 名称(N): — the marker name, accepts AXSetValue',
    time: 'textfield titled 时间(T): — a Bars|Beats position, e.g. "1:01:000"',
    lockToSmpte: 'checkbox titled 锁定至 SMPTE 时间(L)',
    grooveClipPitch: 'combobox titled 律动剪辑音高变更(P):, defaults to <无音高>',
    ok: 'button titled 确定',
    cancel: 'button titled 取消',
    help: 'button titled 帮助',
  },
  how: [
    'Open it with 工程 > 插入标记 (0x807F). It appears as a #32770 window titled 标记.',
    'Set 名称 and 时间 with AXSetValue — both accept writes, because this is a standard '
      + 'Windows dialog and not one of SONAR\'s drawn controls.',
    'Click 确定 by index. 取消 discards.',
  ],
  verified:
    'Setting 名称="Intro" and 时间="1:01:000" then pressing 确定 placed a marker at bar 1: it '
    + 'appeared on the ruler and as a row in the marker list reading "00:00:00:00 | 1:01:000 | Intro".',
  readingBack:
    'The marker list (视图 > 标记) is a table with columns 时:分:秒帧 / Lk / 小节:节拍:嘀嗒 / 音高 / '
    + '名称. A computer-use runtime can read the rows, so a created marker can be confirmed — '
    + 'which the selection cannot, because a selection is only ever drawn.',
};

/**
 * Send a navigation or marker command.
 *
 * Reports honestly: a command that opens a dialog says so and names the elements;
 * one that moves the now-time says the change is drawn and gives what to look at.
 */
export async function navigate(key, { commands = NAV_COMMANDS, confirm } = {}) {
  const cmd = { ...NAV_COMMANDS, ...MARKER_COMMANDS }[key];
  if (!cmd) {
    const e = new Error(`unknown navigation command '${key}'. Known: `
      + `${Object.keys({ ...NAV_COMMANDS, ...MARKER_COMMANDS }).join(', ')}`);
    e.code = 'UNKNOWN_COMMAND';
    throw e;
  }
  // The unknown-command guard above is pure and answers before any process is
  // touched; the document probe below is what actually needs the world.
  // Marker removal is a real edit. runCommand only gates the document-level
  // destructive ids, so the navigation-level ones need their own check.
  if (cmd.destructive && confirm !== key) {
    const e = new Error(`'${key}' is destructive: ${cmd.effect}. Pass confirm: '${key}' to post it.`);
    e.code = 'NEEDS_CONFIRMATION';
    throw e;
  }
  const doc = await documentState();
  if (!doc.projectOpen) {
    const e = new Error(
      'No document is open. Navigation, selection and markers all operate on a project, and the '
      + '编辑 / 工程 menus are not in the menu bar without one.'
    );
    e.code = 'NO_DOCUMENT';
    throw e;
  }

  const result = await runCommand(cmd.cmdId, { keepOverlays: true, confirm });
  await new Promise((r) => setTimeout(r, 900));
  const after = await call('status');

  return describeNavigateResult(cmd, {
    newWindows: result.newWindows || [],
    windowCount: (after.allWindows || []).length,
  });
}

/**
 * Build the report for a navigation command. Pure.
 *
 * What the command IS decides `confirm` and the note; whether a window appeared
 * is the only part that needs the world. Extracted so those rules can be tested
 * without a running SONAR, which they previously required.
 *
 * `next` used to be chosen from `cmd.confirm` alone, so a command whose dialog
 * should have opened said "A dialog should be open" even when `newWindows` was
 * empty and it demonstrably had not. The evidence was in hand and unused. That is
 * the same defect as the one fixed in `classifyEditResult` — a report describing
 * the command instead of the run — and the same measured cause applies: a leftover
 * modal swallows menu commands, so "should have opened" is a case that occurs.
 * When the command expects a dialog and none appeared, say so and name the fix.
 */

/**
 * End a stored fragment with a period, so it can be interpolated into a sentence
 * without running into whatever follows. Stored `whatToLook` values are fragments
 * by design ("the marker list is a TABLE — readable, unlike the track strips"), and
 * one branch produced "...unlike the track strips Read it through..." until this
 * existed — a verifier caught the run-on.
 */
function terminate(s) {
  const t = String(s).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function describeNavigateResult(cmd, { newWindows = [], windowCount } = {}) {
  const expectedDialog = cmd.confirm === 'dialog';
  const openedDialog = (newWindows || []).some((w) =>
    (typeof w === 'string' ? w : w.cls || '').startsWith('#32770'));
  const dialogMissing = expectedDialog && !openedDialog;

  /*
   * `confirm` has three values and `next` used to have two branches, so the third
   * value fell through to the drawn-change wording. For showMarkerView — the one
   * command that declares `elements` — that produced a sentence arguing with
   * itself: "This change is drawn, not exposed" followed by "the marker list is a
   * TABLE — readable". The evidence class was recorded and then contradicted.
   *
   * Attacking the rewrite found a second loss: `whatToLook` was dropped entirely on
   * both dialog branches, so a command that opens a dialog AND names what to look
   * at lost the second half — precisely when it is most useful, since "a dialog
   * should be open" and "no dialog appeared" are the two moments a caller needs to
   * know where to look. Every branch now carries it.
   */
  /*
   * `whatToLook` values are stored without trailing punctuation (they read as
   * fragments: "the marker list is a TABLE — readable, unlike the track strips").
   * Interpolating one straight into a sentence therefore runs it into the next
   * clause. Sentence-terminating it here, once, is what makes every branch safe
   * rather than each branch remembering to.
   */
  const look = cmd.whatToLook ? ` What to look at: ${terminate(cmd.whatToLook)}` : '';
  const lookMid = cmd.whatToLook ? terminate(cmd.whatToLook) : '';

  let next;
  if (dialogMissing) {
    next = 'This command opens a dialog and none appeared. Check for a modal already on screen — '
      + 'cw_list_overlays finds them and cw_close_overlays clears them. A leftover modal '
      + 'swallows menu commands, and that is the usual cause.' + look;
  } else if (expectedDialog) {
    next = `A dialog is open. ${cmd.dialog ? `Its class is ${cmd.dialog.class}; ` : ''}`
      + 'See cw_markers for the element names and how to read the result back.' + look;
  } else if (cmd.confirm === 'elements') {
    // The view itself is drawn, but its CONTENT is exposed — a marker list is a
    // table, so unlike a selection this can actually be read back.
    next = 'This opens a view whose content is exposed as elements'
      + (cmd.whatToLook ? `. ${lookMid}` : '.')
      + ' Read it through the accessibility tree with a computer-use runtime; unlike a selection '
      + 'or a fader, no screenshot is needed.';
  } else if (cmd.confirm === 'screenshot') {
    next = cmd.whatToLook
      ? `This change is drawn, not exposed: ${lookMid} A computer-use runtime confirms it.`
      : 'This change is drawn, not exposed. A computer-use runtime confirms it with a screenshot.';
  } else {
    /*
     * `unprobed` — or any class this function does not know. A verifier pointed out
     * that the old wording ("a gap in the record rather than a property of the
     * command") understated it: for a real command like removeProjectStart, the gap
     * IS a property of the command — it was never measured — and calling it a
     * records problem implies the command is understood and only the paperwork is
     * missing. Say what is actually unknown.
     */
    next = 'NOT PROBED: nothing here establishes how this command can be confirmed, or even that '
      + 'it does what its menu label says. The id and name come from the live menu; the behaviour '
      + 'is unverified. Run it once with a computer-use runtime watching, then record what you '
      + 'saw.' + look;
  }

  return {
    ok: true,
    ran: cmd.name,
    cmdId: cmd.cmdId,
    hex: cmd.hex,
    effect: cmd.effect,
    confirm: cmd.confirm,
    newWindows: (newWindows || []).map((w) => (typeof w === 'string' ? w : `${w.cls}|${w.title}`)),
    dialogOpened: openedDialog,
    expectedDialog,
    dialogMissing,
    /*
     * `whatToLook` is carried as a field, not only folded into `next`. A verifier
     * pointed out that inlining it made the structured "what would I look at"
     * unavailable to a caller that does not want to parse prose — and parsing is
     * exactly what a machine caller should not have to do.
     */
    whatToLook: cmd.whatToLook ?? null,
    next,
    note: cmd.verified,
    windowCount,
  };
}

/** Everything about markers, including the readback path. */
export function markerHelp() {
  return {
    dialog: MARKER_DIALOG,
    commands: MARKER_COMMANDS,
    whyItWorks:
      'The marker dialog is standard MFC, and accessibility can WRITE to standard MFC fields. '
      + 'SONAR\'s own drawn controls accept the same calls and ignore them — which is why the '
      + 'track strips are read-only but this dialog is not. Whenever a drawn surface has a command '
      + 'that opens a dialog, use the dialog.',
    whatCannotBeDone:
      'Deleting an arbitrary marker has no command and no dialog — only the project start/end '
      + 'markers have remove commands (0xA723-0xA725). Deleting a named marker needs the marker '
      + 'list UI.',
  };
}

/** The arranger, kept as a reference because none of it is confirmed. */
/*
 * The arranger commands. Found in SONAR's command index, none verified, none
 * exposed as a tool — and two of them (0xA63B, 0xA63E) were measured to open the
 * membership panel, which is a licence gate rather than a missing feature.
 *
 * Every entry carries `confirm: 'unprobed'` explicitly. That is not ceremony: a
 * verifier showed that leaving the field off let a command sit in a table of
 * measured ones with an empty record, and a rule that exempts a whole table stops
 * being a rule. `effect` states only what the menu label says, which is the most
 * that can honestly be claimed for a command nobody has run.
 */
export const ARRANGER_COMMANDS = {
  createSection: {
    cmdId: 0xA5BC, hex: '0xA5BC', name: '创建编曲小节', en: 'Create arranger section',
    effect: 'stated by the menu only — creates an arranger section',
    confirm: 'unprobed',
  },
  addTrack: {
    cmdId: 0xA63B, hex: '0xA63B', name: '添加编曲音轨', en: 'Add arranger track',
    effect: 'opens the membership panel on this install (licence-gated, measured)',
    confirm: 'unprobed',
    licenceGated: true,
  },
  deleteTrack: {
    cmdId: 0xA63C, hex: '0xA63C', name: '删除编曲音轨', en: 'Delete arranger track',
    effect: 'stated by the menu only — deletes an arranger track',
    confirm: 'unprobed',
    destructive: true,
  },
  renameTrack: {
    cmdId: 0xA63D, hex: '0xA63D', name: '重命名编曲音轨', en: 'Rename arranger track',
    effect: 'stated by the menu only — renames an arranger track',
    confirm: 'unprobed',
  },
  toggleView: {
    cmdId: 0xA5E2, hex: '0xA5E2', name: '显示/隐藏编曲', en: 'Show/hide arranger',
    effect: 'stated by the menu only — toggles the arranger view',
    confirm: 'unprobed',
  },
  toggleInspector: {
    cmdId: 0xA61D, hex: '0xA61D', name: '显示/隐藏编曲查看器', en: 'Show/hide arranger inspector',
    effect: 'stated by the menu only — toggles the arranger inspector',
    confirm: 'unprobed',
  },
  note: 'Not probed. The arranger is a separate view; these commands were found in the index and '
    + 'are recorded here so a later round does not have to re-discover them, but none has been '
    + 'verified and none is exposed as a tool. Two of them were measured to hit a licence gate.',
};
