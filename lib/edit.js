// lib/edit.js — the editing and processing commands, and why they need a precondition.
//
// This module exists because of a measurement mistake worth recording. Probing
// 量化 / 移调 / 分割剪辑 with no selection produced `unconfirmed` for all of
// them, and it would have been easy to write "these do not work". They work fine
// — an edit command on an empty selection is *supposed* to do nothing. Selecting
// everything first made all three open their dialogs immediately:
//
//   no selection   0x8061 处理>量化     unconfirmed
//   select all     0x8061 处理>量化     opens #32770 「量化」
//   no selection   0x8066 处理>移调     unconfirmed
//   select all     0x8066 处理>移调     opens #32770 「移调」
//   no selection   0x8012 分割剪辑      unconfirmed
//   select all     0x8012 分割剪辑      opens #32770 「分割剪辑」
//
// So a probe result of "nothing happened" has three distinct causes on this
// build, and telling them apart matters because only one of them is a limit:
//
//   1. drawn, not exposed   — a selection or a fader moves and nothing is
//                             readable; the change really did happen
//   2. precondition missing — an edit with no selection, an export with nothing
//                             to export; the command is fine, the state was not
//   3. gated by licence     — three arranger commands open the membership panel
//
// The three dialogs above are the payoff: standard MFC, so their fields accept
// AXSetValue, exactly like the marker and file dialogs. For 量化 that has been
// measured all the way through — writes land, 确定 commits, and the result shows
// in the exported file. See lib/note-edit.js for that round trip and for the two
// measurement mistakes it took to establish it.

import { call } from '../bridge/agent.js';
import { runCommand } from './menu.js';
import { documentState } from './track-ui.js';
import { navigate } from './navigate.js';

/**
 * Editing commands. `precondition` is what must be true before the command does
 * anything — the field that turns "unconfirmed" into an answer.
 */
export const EDIT_COMMANDS = {
  quantize: {
    cmdId: 0x8061, hex: '0x8061', name: '处理 > 量化', en: 'Process > Quantize',
    precondition: 'a selection',
    affects: 'note start times, snapping them to a grid',
    outcome: 'opens a #32770 dialog titled 量化',
    verified: 'unconfirmed with no selection, opened the dialog immediately after 编辑 > 选择 > 全部',
  },
  grooveQuantize: {
    cmdId: 0x8062, hex: '0x8062', name: '处理 > 律动量化', en: 'Process > Groove Quantize',
    precondition: 'a selection',
    affects: 'note timing, durations and velocities against a groove template',
    outcome: 'opens a #32770 dialog titled 律动量化',
    verified: 'MEASURED 2026-10-15. Dialog fields: 律动样板(P)=59 (combobox, default '
      + '"01 Shuffle Feel A"), 律动文件(F)=64 (combobox, default "Cakewalk DNA Grooves.grv"), '
      + '精度(R)=55 (combobox) AND 57 (textfield — the same label-on-two-controls trap as 量化\'s '
      + '时值; write the textfield), 灵敏度(S)=52 (textfield, default 100), '
      + '如果超出灵敏度，则(O)=47 (combobox, default 不改变), and three strength sliders '
      + '时间(M)=38, 时值(D)=33, 力度(V)=28 with numeric fields 24/23/22 (all default 100). '
      + '确定=11, 取消=10, 试听(A)=8. Elements 23/24 share the label 关闭 with value 100 — the '
      + 'slider readouts, not buttons.',
  },
  transpose: {
    cmdId: 0x8066, hex: '0x8066', name: '处理 > 移调', en: 'Process > Transpose',
    precondition: 'a selection',
    affects: 'note pitches by a semitone interval',
    outcome: 'opens a #32770 dialog titled 移调',
    verified: 'unconfirmed with no selection; opened the 移调 dialog immediately after '
      + '编辑 > 选择 > 全部 — the same selection precondition as quantize',
  },
  splitClips: {
    cmdId: 0x8012, hex: '0x8012', name: '分割剪辑...', en: 'Split Clips',
    precondition: 'a selection',
    affects: 'splits clips at a chosen position',
    outcome: 'opens a #32770 dialog titled 分割剪辑',
    risk: 'destructive',
    verified: 'unconfirmed with no selection, opened the 分割剪辑 dialog after 编辑 > 选择 > 全部',
  },
  splitAtNow: {
    cmdId: 0x8354, hex: '0x8354', name: '在当前时间分割剪辑', en: 'Split at Now',
    precondition: 'a selection covering the now-time',
    affects: 'splits clips at the now-time with no dialog',
    outcome: 'silent — the split is structural, so the clip count changes',
    risk: 'destructive',
    riskWhy: 'and with no confirmation step — the split lands as soon as the command posts',
  },
  splitMidiNotes: {
    cmdId: 0xA660, hex: '0xA660', name: '分割 MIDI 音符', en: 'Split MIDI Notes',
    precondition: 'a selection in the Event List or Piano Roll',
    affects: 'splits notes crossing the split point',
    risk: 'destructive',
  },
  mergeClips: {
    cmdId: 0x82D4, hex: '0x82D4', name: '合并至剪辑', en: 'Bounce to Clip',
    precondition: 'a selection',
    affects: 'renders the selection into a single clip',
    risk: 'destructive',
    riskWhy: 'the source events are replaced, so undo is the only way back',
  },
  gain: {
    cmdId: 0x863F, hex: '0x863F', name: '处理 > 增益', en: 'Process > Gain',
    precondition: 'audio in the selection',
    affects: 'audio level',
    outcome: 'silent on a MIDI-only selection — there is no audio to change',
  },
  normalize: {
    cmdId: 0x805D, hex: '0x805D', name: '处理 > 规格化', en: 'Process > Normalize',
    precondition: 'audio in the selection',
    affects: 'audio peaks',
    risk: 'destructive',
  },
  reverse: {
    cmdId: 0x8060, hex: '0x8060', name: '处理 > 反转', en: 'Process > Reverse',
    precondition: 'audio in the selection',
    affects: 'audio playback direction',
    risk: 'destructive',
  },
  removeSilence: {
    cmdId: 0x8056, hex: '0x8056', name: '处理 > 删除无声', en: 'Process > Remove Silence',
    precondition: 'audio in the selection',
    affects: 'removes silent passages, shortening the clip',
    risk: 'destructive',
  },
  fadeEnvelope: {
    cmdId: 0x805E, hex: '0x805E', name: '处理 > 淡变/包络', en: 'Process > Fade/Envelope',
    precondition: 'a selection',
    affects: 'a fade shape over the selection',
    risk: 'destructive',
  },
  /* The selection commands are here too, because every edit above needs one. */
  selectAll: { cmdId: 0x804C, hex: '0x804C', name: '编辑 > 选择 > 全部', en: 'Select All',
    precondition: 'none — this IS the precondition for the edits' },
  selectNone: { cmdId: 0x804D, hex: '0x804D', name: '编辑 > 选择 > 取消', en: 'Select None' },

  /*
   * The note-level processors. These are why "no CakeScript" does not mean "no
   * note editing": every one acts on a selection, is postable by id from this
   * process, and either opens an MFC dialog whose fields accept AXSetValue or
   * works silently. They were found by mining SONAR's own command index
   * (cwsearch.dat, SQLite) for 处理-menu rows carrying a live CMD_ID — the index
   * also has a SCRIPT_CMD column naming the CakeScript verb for each id, which
   * is how each was matched to the capability it stands in for.
   *
   * Measured on 2026.10: 量化 and 移调 both open their #32770 dialog after
   * 编辑 > 选择 > 全部, and their fields were read and written. The ones marked
   * `unprobed` have not been opened — do not read a name here as a measurement.
   */
  scaleVelocity: {
    cmdId: 0x8067, hex: '0x8067', name: '处理 > 力度', en: 'Process > Scale Velocity',
    precondition: 'a selection',
    affects: 'note velocities, scaled as a percentage',
    outcome: 'opens a #32770 dialog titled 力度',
    verified: 'MEASURED 2026-10-15. Dialog fields: 开始(B)=9, 结束(E)=7 (textfields, both '
      + 'default 100), 百分比(P)=6 (checkbox), 确定=5, 取消=4. The two numbers are the endpoints '
      + 'of a velocity-scaling ramp across the selection, so equal values scale uniformly. '
      + 'Verified end to end: writing 50/50 took every velocity from 100 to 50 in the export.',
  },
  length: {
    cmdId: 0x8064, hex: '0x8064', name: '处理 > 音长', en: 'Process > Length',
    precondition: 'a selection',
    affects: 'note durations, scaled as a percentage',
    outcome: 'opens a #32770 dialog titled 长度 (not 音长 — the menu label and the dialog title differ)',
    verified: 'MEASURED 2026-10-15. Dialog fields: 按照(B)=24 (textfield, default 100.000, the '
      + 'scale percentage), 时值(D)=26 and 开始时间(S)=27 (checkboxes, BOTH ON by default — so a '
      + 'bare 确定 scales duration AND start time), 拉伸音频(A)=22 (checkbox, ON by default; turn '
      + 'it off for MIDI), 确定=17, 取消=16. Verified end to end: writing 50 halved every duration '
      + '(400→200) and every start tick (0,480,960… → 0,240,480…) because both boxes were ticked.',
  },
  retrograde: {
    cmdId: 0x8065, hex: '0x8065', name: '处理 > 倒置', en: 'Process > Retrograde',
    precondition: 'a selection',
    affects: 'reverses the PITCH sequence across the selection; the time positions do not move',
    outcome: 'silent — no dialog, posting the command IS the edit',
    risk: 'destructive',
    verified: 'MEASURED 2026-10-15, and this corrects an earlier guess. The previous note here '
      + 'said "reverses the order of the notes", which is wrong. Verified from an export: notes at '
      + 'ticks 0,240,480… with pitches 63,65,67,68,70,72,74,75 came back as pitches '
      + '75,74,72,70,68,67,65,63 at the SAME ticks. So it mirrors the pitch contour in place — the '
      + 'rhythm is untouched. Because it needs no dialog, this command is fully automatable '
      + 'without a computer-use runtime.',
  },
  fitToTime: {
    cmdId: 0x8068, hex: '0x8068', name: '处理 > 时间匹配', en: 'Process > Fit to Time',
    precondition: 'a selection with a time range',
    affects: 'stretches or compresses the selection so it ends at a given time',
    outcome: 'opens a #32770 dialog titled 时间匹配',
    verified: 'MEASURED 2026-10-15. Dialog fields: 新结束时间(N)=27 (textfield, default '
      + '00:00:01:29 — the target end time, format H:MM:SS:FF), 事件时间(E)=24 and 速度映射(M)=25 '
      + '(radios; 事件时间 is the default and is the one that stretches notes), 拉伸音频(S)=23 '
      + '(checkbox), 格式(O)=16 (changes the time format), 确定=18, 取消=17. The dialog also '
      + 'displays the 原始时间范围 read-only. Writing 00:00:00:14 read back correctly.',
  },
  findChange: {
    cmdId: 0x8063, hex: '0x8063', name: '处理 > 查找/更改', en: 'Process > Find/Change',
    precondition: 'a selection',
    affects: 'SELECTS the events matching a filter — despite the name it does not change them',
    outcome: 'opens a #32770 dialog titled 事件过滤器 - 搜索',
    verified: 'MEASURED 2026-10-15, correcting another wrong guess. This is not a batch-replace: '
      + 'the dialog is an event FILTER (141 elements) whose per-event-type rows carry 包含/排除 '
      + 'checkboxes and min/max ranges — 音高, 力度, 时值, 通道, 拍, 嘀嗒 and more. It narrows the '
      + 'selection; a second 处理 command then acts on the result. Key fields: 确定=10, 取消=9, '
      + '全选=21, 不选=20, 音符(N)=139, and the note row reads 音高 min/max=115/114, '
      + '力度 min/max=128/127, 时值 min/max=122/121. Treat it as an advanced selector, not an edit.',
  },
  slide: {
    cmdId: 0x8043, hex: '0x8043', name: '处理 > 移动', en: 'Process > Slide',
    precondition: 'a selection',
    affects: 'shifts events in time by a signed amount in a chosen unit',
    outcome: 'opens a #32770 dialog titled 移动',
    verified: 'MEASURED 2026-10-15. Dialog fields: 移动量(B)=10 (textfield, default 0, SIGNED), '
      + 'unit radios 小节(M)=9, 嘀嗒(T)=8, 秒(S)=7, 帧(F)=6, targets 音轨中的事件(E)=13 '
      + '(checkbox, ON by default) and 标记(K)=12, 确定=5, 取消=4. The unit decides what 移动量 '
      + 'means, so always select one explicitly. Writing 1 and ticking 小节 read back correctly.',
  },

  /*
   * 轻移 (nudge) — eight commands, and the most precise time/pitch control
   * available without CakeScript. They are the only entries here that act with
   * NO dialog at all: posting the id IS the edit. That also means there is no
   * confirmation step and no way to inspect the parameters first, so treat them
   * as immediate. NudgeUp/Down move pitch (a semitone for MIDI); the Left/Right
   * family move in time by whatever 轻移 > 设置 defines as a step.
   *
   * Measured 2026-10-15: posting nudge up and right produces no window change
   * and no dialog, which is what a drawn-only effect looks like from this
   * process. 倒置 was in the same "silent" class and turned out to genuinely
   * edit notes in place, so a silent nudge is more likely to be a real edit than
   * a swallowed command — but that is an inference, not a measurement, so the
   * pitch/time shift itself stays unverified until an export is compared.
   *
   * What each step IS, measured: 处理 > 轻移 > 设置 does not open a small dialog
   * — it opens the global 参数设置 preferences window on its 轻移 page. The three
   * steps are independently configurable, NOT a small/medium/large ramp:
   *
   *   轻移 1 = 10 毫秒 (value element 109, unit 106, 绝对时间 radio 114)
   *   轻移 2 = 1 帧   (value 98, unit 95, 绝对时间 103)
   *   轻移 3 = 2 帧   (value 87, unit 84, 绝对时间 92)
   *
   * Each step also chooses 绝对时间 / 音乐时间 (musical, in 小节) / 使用对齐设置.
   * The 10 ms default for step 1 is why a nudge looks like nothing happened: it
   * is a real audio-scale move, but far below one MIDI tick at ordinary tempos.
   * Reaching a tick-scale nudge means changing these preferences first.
   */
  nudgeLeft1: { cmdId: 0x846F, hex: '0x846F', name: '处理 > 轻移 > 向左-1', en: 'Nudge Left 1',
    precondition: 'a selection',
    affects: 'nudges the selection earlier in time', outcome: 'silent — a drawn change, no dialog' },
  nudgeRight1: { cmdId: 0x8470, hex: '0x8470', name: '处理 > 轻移 > 向右-1', en: 'Nudge Right 1',
    precondition: 'a selection',
    affects: 'nudges the selection later in time', outcome: 'silent — a drawn change, no dialog' },
  nudgeLeft2: { cmdId: 0x852C, hex: '0x852C', name: '处理 > 轻移 > 向左-2', en: 'Nudge Left 2',
    precondition: 'a selection',
    affects: 'nudges by the second step size', outcome: 'silent' },
  nudgeRight2: { cmdId: 0x852D, hex: '0x852D', name: '处理 > 轻移 > 向右-2', en: 'Nudge Right 2',
    precondition: 'a selection',
    affects: 'nudges by the second step size', outcome: 'silent' },
  nudgeLeft3: { cmdId: 0x852E, hex: '0x852E', name: '处理 > 轻移 > 向左-3', en: 'Nudge Left 3',
    precondition: 'a selection',
    affects: 'nudges by the third step size', outcome: 'silent' },
  nudgeRight3: { cmdId: 0x852F, hex: '0x852F', name: '处理 > 轻移 > 向右-3', en: 'Nudge Right 3',
    precondition: 'a selection',
    affects: 'nudges by the third step size', outcome: 'silent' },
  nudgeUp: { cmdId: 0x8530, hex: '0x8530', name: '处理 > 轻移 > 向上', en: 'Nudge Up',
    precondition: 'a selection',
    affects: 'moves the selection up — one semitone of pitch for MIDI',
    outcome: 'silent — a drawn change, no dialog' },
  nudgeDown: { cmdId: 0x8531, hex: '0x8531', name: '处理 > 轻移 > 向下', en: 'Nudge Down',
    precondition: 'a selection',
    affects: 'moves the selection down — one semitone of pitch for MIDI',
    outcome: 'silent — a drawn change, no dialog' },
  nudgeSettings: { cmdId: 0x8532, hex: '0x8532', name: '处理 > 轻移 > 设置', en: 'Nudge Settings',
    precondition: 'none — this edits preferences, not project data',
    affects: 'defines what each of the three nudge steps is, in time',
    outcome: 'opens the global 参数设置 preferences window on its 轻移 page (NOT a small dialog)',
    verified: 'MEASURED 2026-10-15. The window is 参数设置 (117 elements) with the 轻移 page '
      + 'selected. Defaults: 轻移 1 = 10 毫秒, 轻移 2 = 1 帧, 轻移 3 = 2 帧, each with '
      + '绝对时间/音乐时间/使用对齐设置 radios. 确定=41, 取消=40, 应用=39. This changes an '
      + 'application preference that persists, so a caller should prefer 取消 unless the change '
      + 'is genuinely wanted.',
    risk: 'destructive',
    riskWhy: 'it writes an application preference, not project data — undo does not cover it, and '
      + 'the change outlives the project.' },
};

/** Dialogs behind the edit commands. Same writable-by-accessibility story. */
export const EDIT_DIALOGS = {
  quantize: {
    title: '量化',
    how: 'opened by 处理 > 量化 (0x8061) once something is selected',
    fields: 'a resolution grid, a strength/percentage, and scope options; the defaults are '
      + 'usually what you want, so pressing 确定 is often enough',
  },
  transpose: {
    title: '移调',
    how: 'opened by 处理 > 移调 (0x8066) once something is selected',
    fields: 'a semitone interval (数量(A), element 25, signed), 全音数(D) element 24 to count '
      + 'whole tones, and audio-only controls that grey out for a MIDI selection',
    verified: 'MEASURED 2026-10-15 end to end: a C-major scale exported as 60,62,64,65,67,69,71,72 '
      + 'came back 63,65,67,68,70,72,74,75 after writing 3 into element 25 and pressing 确定 — '
      + 'every note +3 semitones, with a no-edit control export showing zero drift. See '
      + 'TRANSPOSE_DIALOG in note-edit.js for the full field table.',
  },
  splitClips: {
    title: '分割剪辑',
    how: 'opened by 分割剪辑... (0x8012) once something is selected',
    fields: 'the split position and how to handle clip boundaries',
  },
  why:
    'All of these are standard MFC dialogs, so their fields accept AXSetValue — the same property '
    + 'that makes the file dialog and the marker dialog writable while SONAR\'s own controls are not. '
    + 'But note the limit found on 2026-10-15: the number fields are backed by SONAR\'s CC:SpinCtrl, '
    + 'and a raw WM_SETTEXT on the shadow Edit reports success while the value reverts. The write '
    + 'must go through an accessibility runtime (AXSetValue / computer-use setValue), which is what '
    + 'the field tables above are for.',
};

/**
 * Ensure a selection exists before running an edit that needs one.
 *
 * This is the whole lesson of the module in one function: rather than reporting
 * "the command did nothing", satisfy the precondition and try again.
 *
 * What it can and cannot establish. 编辑 > 选择 > 全部 is a *drawn* change — it
 * highlights the ruler and produces no new window — so neither this function nor
 * the caller can confirm from here that a selection now exists. All either of
 * them knows is that the command was posted. That is why the result reports
 * `selectionRequested` rather than claiming a selection was made: the earlier
 * wording, `preconditionSatisfied: 'selected all first'`, asserted an outcome
 * this code has no way to observe. It was measured to matter — a leftover modal
 * window swallows menu commands entirely (see `likelySwallowed`), and in that
 * case select-all does nothing while the old field still claimed it had worked.
 *
 * Returns the runCommand result so a caller can see whether the post even landed.
 */
export async function withSelection(fn, { assumeSelected = false } = {}) {
  let selectionPost = null;
  if (!assumeSelected) {
    // 编辑 > 选择 > 全部. Fires silently by design, so there is nothing to await
    // beyond giving the modal loop a moment.
    selectionPost = await runCommand(0x804C, { keepOverlays: true });
    await new Promise((r) => setTimeout(r, 700));
  }
  const out = await fn();
  return { out, selectionPost, assumeSelected };
}

/**
 * Turn what was observed into a report. Pure, so the reporting rules — including
 * the false-positive fixes below — can be tested without a running SONAR.
 *
 * The rule that made this worth extracting: `cmd.outcome` DESCRIBES what the
 * command does when it works ("opens a #32770 dialog titled 量化"). Using it as
 * the outcome of a run that produced no window made a failed invocation read
 * like a successful one — measured, one run reported an empty `newWindows` while
 * `outcome` still claimed a dialog had opened. `outcome` now carries only what
 * was seen, and `expected` carries the description, so the two cannot be
 * confused by a reader or by a test.
 */
export function classifyEditResult(cmd, { newWindows = [], selectFirst = true } = {}) {
  const openedDialog = newWindows.some((w) => w.startsWith('#32770'));
  const observed = openedDialog ? 'dialog-opened' : 'no-window-change';
  const expectDialog = /dialog/i.test(cmd.outcome || '');
  const likelySwallowed = !openedDialog && expectDialog;

  /*
   * `selectionRequested`, not `preconditionSatisfied`. Select-all is drawn, so
   * whether a selection now exists is NOT knowable from this process — the old
   * field name claimed an outcome no code here can observe, and a swallowed
   * menu command (measured: a leftover modal does exactly that) would leave it
   * claiming success. Report the attempt, and say what settling it would take.
   */
  return {
    ok: true,
    ran: cmd.name,
    cmdId: cmd.cmdId,
    hex: cmd.hex,
    affected: cmd.affects,
    precondition: cmd.precondition,
    selectionRequested: selectFirst
      ? 'posted 编辑 > 选择 > 全部'
      : 'not attempted — caller asserted a selection already exists',
    selectionConfirmed: false,
    selectionEvidence:
      'Select-all changes no window and adds no element — it highlights the ruler. So this '
      + 'process cannot tell a working select-all from one a modal swallowed. If the edit that '
      + 'follows also did nothing (see likelySwallowed), the selection is the likely cause and a '
      + 'screenshot is the only way to settle it.',
    outcome: observed,
    expected: cmd.outcome,
    newWindows,
    // The one case worth flagging: a command that should open a dialog and did
    // not. The usual cause is a modal already on screen swallowing the menu
    // command, which is recoverable rather than broken.
    likelySwallowed,
    next: openedDialog
      ? 'A dialog is open. Its fields accept AXSetValue; cw_note_edit_help gives the field kinds '
        + 'and the verification round trip. Press 确定 (AXPress) to apply.'
      : likelySwallowed
        ? 'This command normally opens a dialog and none appeared. Check for a modal already on '
          + 'screen — cw_list_overlays finds them, cw_close_overlays clears them. A leftover modal '
          + 'swallows menu commands, and that is the usual cause.'
        : cmd.risk === 'destructive'
          ? 'This command edits without a dialog, so there is nothing to confirm it by. '
            + 'The change shows in the clip or event data — check with a computer-use runtime.'
          : cmd.outcome,
    risk: cmd.risk,
    verified: cmd.verified,
  };
}

/**
 * Run an editing command, satisfying its precondition first.
 *
 * Returns the dialog that opened, if one did. For a destructive command the
 * caller should pass `confirm`, on the same reasoning as lib/project.js: a split
 * or a normalize cannot be undone by re-running it.
 */
export async function edit(key, { confirm, selectFirst = true } = {}) {
  const cmd = EDIT_COMMANDS[key];
  if (!cmd) {
    const e = new Error(`unknown edit command '${key}'. Known: ${Object.keys(EDIT_COMMANDS).join(', ')}`);
    e.code = 'UNKNOWN_COMMAND';
    throw e;
  }

  /*
   * Argument checks come BEFORE the document probe, deliberately.
   *
   * These two guards are pure: they depend only on what the caller passed, so
   * they can always be answered. Putting them after `documentState()` made a
   * malformed call wait on the PowerShell bridge — and, worse, made the answer
   * depend on whether SONAR happened to be running. A caller who passed a
   * destructive command with no confirmation should be told that immediately,
   * not after a process round trip.
   */
  if (cmd.risk === 'destructive' && confirm !== key) {
    const e = new Error(
      `${cmd.name} is destructive: ${cmd.affects}. Pass confirm: '${key}' to proceed. `
      + 'Undo (0xE12B) is the only way back.'
    );
    e.code = 'NEEDS_CONFIRMATION';
    throw e;
  }

  const doc = await documentState();
  if (!doc.projectOpen) {
    const e = new Error('No document is open, so there is nothing to edit and no 处理 menu.');
    e.code = 'NO_DOCUMENT';
    throw e;
  }

  const { out: ran } = await withSelection(async () => {
    const before = await call('status');
    const posted = await runCommand(cmd.cmdId, { keepOverlays: true, confirm });
    await new Promise((r) => setTimeout(r, 1100));
    const after = await call('status');
    const b = new Set((before.allWindows || []).map((w) => `${w.cls}|${w.title}`));
    return {
      posted: posted.posted,
      newWindows: (after.allWindows || []).filter((w) => !b.has(`${w.cls}|${w.title}`))
        .map((w) => `${w.cls}|${w.title}`),
    };
  }, { assumeSelected: !selectFirst });

  /*
   * The wiring guard. `withSelection` returns `{ out, selectionPost, ... }`, and
   * an earlier version destructured it as `const ran = await withSelection(...)`
   * — so `ran.newWindows` was undefined, `newWindows` became [], and the report
   * said "no-window-change" for a command that had worked. The failure was
   * invisible from outside: an empty window list is also what a correct run
   * against an empty project looks like.
   *
   * Extracted to a pure function so the guard itself is testable without SONAR
   * — see requireWindowList below and its tests in edit.test.mjs.
   */
  requireWindowList(ran);

  return classifyEditResult(cmd, { newWindows: ran.newWindows, selectFirst });
}

/**
 * Fail loudly when the window list did not survive the trip out of
 * `withSelection`.
 *
 * This exists because the alternative failure mode is silent and plausible: a
 * missing list becomes `[]`, `[]` means "no new windows", and "no new windows"
 * is a legitimate result for an edit against an empty project. A caller cannot
 * distinguish "the edit did nothing" from "the edit layer is miswired", so
 * neither can a test — unless the wiring is checked where it can still be told
 * apart from the outcome.
 *
 * Exported and pure on purpose: the guard is the one part of this path that can
 * be verified deterministically, with no SONAR running and no project open.
 */
export function requireWindowList(ran) {
  if (!ran || !Array.isArray(ran.newWindows)) {
    const e = new Error(
      'internal: withSelection did not report a window list, so this result cannot be trusted. '
      + 'This is a wiring fault in edit(), not a property of the edit.'
    );
    e.code = 'EDIT_WIRING_FAULT';
    e.got = ran;
    throw e;
  }
  return ran.newWindows;
}

/** Everything about the editing layer, including the three-cause taxonomy. */
export function editHelp() {
  return {
    commands: EDIT_COMMANDS,
    dialogs: EDIT_DIALOGS,
    whyPreconditionsMatter: {
      finding: 'A probe that reports "nothing happened" has three distinct causes on this build, '
        + 'and conflating them is how a working command gets written off as broken.',
      causes: [
        { cause: 'drawn, not exposed',
          means: 'the change happened but is only visible — a selection, a fader, the now-time',
          example: '选择全部 fires and the ruler highlights; no element changes',
          handle: 'confirm with a screenshot' },
        { cause: 'precondition missing',
          means: 'the command is fine, the project state was not',
          example: '量化 with no selection does nothing; with a selection it opens its dialog',
          handle: 'satisfy the precondition and retry — this module does that automatically' },
        { cause: 'gated by licence',
          means: 'the feature needs a paid tier',
          example: 'two arranger commands open the membership panel',
          handle: 'report it; do not retry' },
      ],
    },
    editorPrecondition:
      'Every command in this module except the two selection ones needs something selected. '
      + 'That is why runAndClassify reporting "unconfirmed" is not a verdict — check the '
      + 'precondition before drawing a conclusion.',
  };
}
