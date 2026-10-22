// lib/verify.js — confirm a command did something, when the window list cannot.
//
// Why this exists. `cw_verify_commands` decides a command worked by diffing the
// top-level window list. That test is blind to anything that changes state
// inside the existing frame — which is most of SONAR's UI: view switches, toggle
// buttons, transport state, per-track flags. Probing the uncovered commands
// showed the cost of the blind spot directly:
//
//   0x8072 视图 > 速度        no window change   — but TEMPOTRACKVIEW appeared
//   0x82CE 显示/隐藏总线区域    no window change   — but the track view repainted
//   0x80B9 循环开关            no window change   — a toggle by definition
//
// So "no window change" was being read as "nothing happened", and an earlier
// round concluded several commands were unhandled on that basis.
//
// The honest position: from this process, a non-window-changing command CANNOT
// be confirmed. The accessibility tree and the pixels are the only witnesses,
// and both need a computer-use runtime. So this module does not pretend to
// verify. It says which witness could answer, and it keeps the record of what
// has and has not been established.

import { call } from '../bridge/agent.js';
import { runCommand } from './menu.js';

/**
 * Why a probe can report "nothing happened". Three causes, and only one is a limit.
 *
 * This taxonomy came out of getting it wrong twice. First a window diff was read
 * as "the command is unhandled" when the change was merely invisible. Then an
 * edit command was read as broken when it simply had no selection. Both are
 * recorded here so the next probe starts from the right question.
 */
export const NO_EFFECT_CAUSES = [
  {
    cause: 'drawn-not-exposed',
    howToTell: 'the command is a toggle, a transport action, a selection or a fader move',
    means: 'it worked; the result is pixels, not an element',
    action: 'confirm with a screenshot or the tree through a computer-use runtime',
    example: '循环开关 (0x80B9), 选择全部 (0x804C), 视图 > 速度 (0x8072)',
  },
  {
    cause: 'precondition-missing',
    howToTell: 'the command is an edit, an export, or operates on a selection',
    means: 'the command is fine; the project state was not',
    action: 'satisfy the precondition and retry — e.g. 编辑 > 选择 > 全部 first',
    example: '量化 (0x8061) and 移调 (0x8066) are silent until something is selected',
  },
  {
    cause: 'gated-by-licence',
    howToTell: 'a JUCE PaywallWindow appears, or the command is an arranger operation',
    means: 'the feature needs a paid tier on this install',
    action: 'report it as a licence gate and stop — there is nothing to retry, because the '
      + 'gate is not a state you can change from here',
    example: '添加编曲音轨 (0xA63B) and 复制编曲音轨 (0xA63E) open the membership panel',
  },
];

/**
 * How a result can be confirmed, strongest first. Kept as an enum so a caller
 * can filter on it rather than reading prose.
 */
export const EVIDENCE = {
  WINDOW: 'window',         // a new top-level window appeared — this process can see it
  ELEMENTS: 'elements',     // the accessibility tree changed — needs a computer-use runtime
  SCREENSHOT: 'screenshot',  // the pixels changed — needs a computer-use runtime
  ACCEPTED: 'accepted',      // the command was posted and nothing errored — weakest
};

/**
 * Classify a command by what it can do, so a caller knows what evidence to expect
 * before running it. `kind` is what the command changes, not what it is.
 */
export const COMMAND_KINDS = {
  opensDialog: {
    kind: 'opensDialog',
    evidence: [EVIDENCE.WINDOW],
    example: '编辑 > 历史 (0x8044) opens a #32770 dialog — this process sees it',
  },
  opensView: {
    kind: 'opensView',
    evidence: [EVIDENCE.ELEMENTS, EVIDENCE.SCREENSHOT],
    example: '视图 > 速度 (0x8072) adds TEMPOTRACKVIEW — invisible to a window diff',
  },
  toggles: {
    kind: 'toggles',
    evidence: [EVIDENCE.SCREENSHOT],
    example: '循环开关 (0x80B9) flips a button state with no new window at all',
  },
  transport: {
    kind: 'transport',
    evidence: [EVIDENCE.SCREENSHOT, EVIDENCE.ELEMENTS],
    example: '录制 / 播放 / 停止 move the now-time and light the transport buttons',
  },
  editsData: {
    kind: 'editsData',
    evidence: [EVIDENCE.ELEMENTS, EVIDENCE.SCREENSHOT],
    example: '量化 / 移调 change notes or open a dialog, depending on selection',
  },
  writesFile: {
    kind: 'writesFile',
    evidence: [EVIDENCE.WINDOW, EVIDENCE.SCREENSHOT],
    example: '保存 / 导出 usually open a dialog; a silent save shows only in the title',
  },
};

/** The measured classification for the commands this adapter exposes. */
export const COMMAND_EVIDENCE = [
  { cmdId: 0x882D, hex: '0x882D', name: '编辑 > 参数设置', kind: 'opensDialog', confirmed: true },
  { cmdId: 0xE140, hex: '0xE140', name: '帮助 > 关于', kind: 'opensDialog', confirmed: true },
  { cmdId: 0xA783, hex: '0xA783', name: 'Cakewalk 助理', kind: 'toggles', confirmed: true,
    note: 'toggles a JUCE panel — a window diff does see this one appear and disappear' },
  { cmdId: 0xA798, hex: '0xA798', name: '工具 > 视频引擎设置', kind: 'opensDialog', confirmed: true },
  { cmdId: 0x8036, hex: '0x8036', name: '重置 MIDI 和音频', kind: 'opensDialog', confirmed: true },
  { cmdId: 0x80B3, hex: '0x80B3', name: '文件 > 新建', kind: 'opensDialog', confirmed: true },
  { cmdId: 0xE101, hex: '0xE101', name: '文件 > 打开', kind: 'opensDialog', confirmed: true },
  { cmdId: 0x8044, hex: '0x8044', name: '编辑 > 历史', kind: 'opensDialog', confirmed: true,
    note: 'opens a #32770 dialog titled 历史' },
  { cmdId: 0x8294, hex: '0x8294', name: '视图 > 音轨视图', kind: 'opensView', confirmed: true,
    note: 'confirmed by reading CTRACKVIEW in the tree, not by a window diff' },
  { cmdId: 0x8072, hex: '0x8072', name: '视图 > 速度', kind: 'opensView', confirmed: true,
    note: 'adds TEMPOTRACKVIEW / TEMPOTRACKHEADERVIEW_TEMPOTRACK / 速度音轨' },
  { cmdId: 0x8073, hex: '0x8073', name: '视图 > 拍号/调号', kind: 'opensView', confirmed: false },
  { cmdId: 0x82CE, hex: '0x82CE', name: '显示/隐藏总线区域', kind: 'toggles', confirmed: true,
    note: 'repaints the track view; no window appears' },
  { cmdId: 0x82A6, hex: '0x82A6', name: '插入 > MIDI 轨', kind: 'editsData', confirmed: true,
    note: 'confirmed by counting track strips in the tree (3 -> 4)' },
  { cmdId: 0x82A5, hex: '0x82A5', name: '插入 > 音频轨', kind: 'editsData', confirmed: false },
  { cmdId: 0x8425, hex: '0x8425', name: '插入 > 立体声总线', kind: 'editsData', confirmed: false },
  { cmdId: 0x8105, hex: '0x8105', name: '视图 > AI Assist', kind: 'opensView', confirmed: true,
    note: 'responds by opening the membership panel on a free licence' },
  { cmdId: 0xA78D, hex: '0xA78D', name: '处理 > 运行 CakeScript', kind: 'opensView', confirmed: true,
    note: 'same membership panel; whether it would run on a paid licence is untested' },
  { cmdId: 0xA797, hex: '0xA797', name: '视图 > CakeScript View', kind: 'opensView', confirmed: true,
    note: 'responds, but not as a working script editor on this licence — it opens the same '
      + 'membership panel as AI Assist. It appeared in the live 视图 menu once a project was open, '
      + 'which is the fact that corrected the earlier "this command was removed" reading.' },
  { cmdId: 0x8061, hex: '0x8061', name: '处理 > 量化', kind: 'editsData', confirmed: true,
    note: 'opens #32770 「量化」 — but ONLY with a selection. Probing with none reported '
      + 'unconfirmed, which was a precondition gap, not a broken command.' },
  { cmdId: 0x8066, hex: '0x8066', name: '处理 > 移调', kind: 'editsData', confirmed: true,
    note: 'opens #32770 「移调」, same selection precondition as quantize' },
  { cmdId: 0x8012, hex: '0x8012', name: '分割剪辑...', kind: 'editsData', confirmed: true,
    note: 'opens #32770 「分割剪辑」 with a selection' },
  { cmdId: 0x807F, hex: '0x807F', name: '工程 > 插入标记', kind: 'opensDialog', confirmed: true,
    note: 'opens #32770 「标记」; a marker was created through it and read back from the list' },
  { cmdId: 0x8077, hex: '0x8077', name: '插入发送助理', kind: 'opensDialog', confirmed: true,
    note: 'opens #32770 「插入发送助理...」' },
  { cmdId: 0x804F, hex: '0x804F', name: '编辑 > 选择 > 按时间', kind: 'opensDialog', confirmed: true,
    note: 'opens #32770 「按时间选择」' },
  { cmdId: 0x803A, hex: '0x803A', name: '视图 > 标记', kind: 'opensView', confirmed: true,
    note: 'shows the marker list, which is a READABLE TABLE — that is how the created marker '
      + 'was verified' },
  { cmdId: 0x804C, hex: '0x804C', name: '编辑 > 选择 > 全部', kind: 'toggles', confirmed: false,
    note: 'fires silently by design — a selection is drawn. It is nonetheless the precondition '
      + 'that makes 量化 / 移调 / 分割剪辑 respond.' },
  { cmdId: 0xA63B, hex: '0xA63B', name: '添加编曲音轨', kind: 'editsData', confirmed: false,
    note: 'opens the membership panel on this licence — a licence gate, not a missing feature. '
      + 'An arranger track nonetheless appeared in the tree, so the arranger itself is present.' },
  { cmdId: 0xA63E, hex: '0xA63E', name: '复制编曲音轨', kind: 'editsData', confirmed: false,
    note: 'licence-gated: opens the membership panel' },
  { cmdId: 0x80B9, hex: '0x80B9', name: '循环开关', kind: 'toggles', confirmed: false,
    note: 'no window change, which is expected for a toggle — needs a screenshot to confirm' },
  { cmdId: 0x8171, hex: '0x8171', name: '回放时使用节拍器', kind: 'toggles', confirmed: false },
  { cmdId: 0x8172, hex: '0x8172', name: '录制时使用节拍器', kind: 'toggles', confirmed: false },
  { cmdId: 0x801C, hex: '0x801C', name: '录制', kind: 'transport', confirmed: false },
  { cmdId: 0x801D, hex: '0x801D', name: '播放/停止', kind: 'transport', confirmed: false },
  { cmdId: 0x801F, hex: '0x801F', name: '停止', kind: 'transport', confirmed: false },
  { cmdId: 0xE103, hex: '0xE103', name: '文件 > 保存', kind: 'writesFile', confirmed: false },
  { cmdId: 0xE104, hex: '0xE104', name: '文件 > 另存为', kind: 'writesFile', confirmed: false },
  { cmdId: 0x822B, hex: '0x822B', name: '文件 > 导出 > 音频', kind: 'writesFile', confirmed: false },
  { cmdId: 0x8420, hex: '0x8420', name: '文件 > 导入 > MIDI', kind: 'writesFile', confirmed: false },
];

/**
 * Run a command and report what this process could and could not establish.
 *
 * Deliberately does not claim success from "nothing errored". If no window
 * appeared and the command is not one that opens a dialog, the answer is
 * `unconfirmed` with the witness that would settle it.
 */
export async function runAndClassify(cmdId, { keepOverlays = false, confirm } = {}) {
  const known = COMMAND_EVIDENCE.find((c) => c.cmdId === cmdId);
  const kind = known ? COMMAND_KINDS[known.kind] : null;

  const before = await call('status');
  let posted;
  try {
    posted = await runCommand(cmdId, { keepOverlays, confirm });
  } catch (e) {
    // A destructive id must surface as the caller error it is; a transport that
    // cannot post is a classified result, not an exception, because "the command
    // did nothing" and "nothing was sent" are different answers.
    if (e && e.code === 'NEEDS_CONFIRMATION') throw e;
    return {
      cmdId,
      hex: '0x' + Number(cmdId).toString(16).toUpperCase(),
      name: known?.name,
      kind: known?.kind,
      status: 'not-posted',
      evidenceUsed: 'transport',
      error: e && e.message ? e.message : String(e),
    };
  }
  // A transport that could not post at all is not "the command did nothing".
  // The old code discarded this result, so with no WM_COMMAND transport an
  // arbitrary id came back as did-nothing/unconfirmed instead of an error.
  if (posted && posted.ok === false) {
    return {
      cmdId,
      hex: '0x' + Number(cmdId).toString(16).toUpperCase(),
      name: known?.name,
      kind: known?.kind,
      status: 'not-posted',
      evidenceUsed: posted.effect || 'transport',
      error: posted.error || posted.detail || 'the command could not be posted',
    };
  }
  await new Promise((r) => setTimeout(r, 1200));
  const after = await call('status');

  const b = new Set((before.allWindows || []).map((w) => `${w.cls}|${w.title}`));
  const added = (after.allWindows || []).filter((w) => !b.has(`${w.cls}|${w.title}`));

  let status;
  let evidence;
  if (added.length) {
    status = 'confirmed';
    evidence = EVIDENCE.WINDOW;
  } else if (kind && kind.evidence[0] === EVIDENCE.WINDOW) {
    // Expected to open a window and did not.
    status = 'did-nothing';
    evidence = EVIDENCE.WINDOW;
  } else {
    status = 'unconfirmed';
    evidence = kind ? kind.evidence[0] : EVIDENCE.ACCEPTED;
  }

  return {
    cmdId,
    hex: '0x' + Number(cmdId).toString(16).toUpperCase(),
    name: known?.name,
    kind: known?.kind,
    status,
    evidenceUsed: evidence,
    newWindows: added.map((w) => `${w.cls}|${w.title}`),
    // What would settle it, when this process cannot.
    wouldConfirmWith: status === 'unconfirmed'
      ? 'A computer-use runtime: compare the accessibility tree or a screenshot before and after. '
        + 'A window diff cannot see this class of change, which is why the status is not "failed".'
      : undefined,
    note: known?.note,
  };
}

/** The record, grouped, for cw_command_evidence. */
export function evidenceSummary() {
  const confirmed = COMMAND_EVIDENCE.filter((c) => c.confirmed);
  const unconfirmed = COMMAND_EVIDENCE.filter((c) => !c.confirmed);
  return {
    total: COMMAND_EVIDENCE.length,
    confirmed: confirmed.length,
    unconfirmed: unconfirmed.length,
    kinds: COMMAND_KINDS,
    evidenceStrength: EVIDENCE,
    noEffectCauses: NO_EFFECT_CAUSES,
    confirmedCommands: confirmed,
    unconfirmedCommands: unconfirmed,
    reading:
      'Unconfirmed does not mean broken. Check NO_EFFECT_CAUSES before drawing a conclusion: the '
      + 'change may be drawn rather than exposed, the command may need a selection first, or the '
      + 'feature may need a paid licence. Only the first is a limit of this adapter.',
    lesson:
      'Two rounds got this wrong in different ways. A window diff read invisible change as "command '
      + 'unhandled" (视图 > 速度 was one of them, and it demonstrably opens the tempo track). Then an '
      + 'edit command with no selection was read as broken; with a selection, 量化 / 移调 / 分割剪辑 '
      + 'all open their dialogs. Both were measurement artefacts, not properties of the build.',
  };
}
