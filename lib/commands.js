// lib/commands.js — which SONAR commands WM_COMMAND can drive, and the one
// condition that decides it.
//
// **The condition is whether a project is open.** An earlier round of this work
// measured a fresh SONAR with no document and concluded that the 视图 menu, the
// CakeScript group and the per-track mixer commands were registered without
// handlers. That was wrong. Re-measured with a 16-track project open:
//
//   no project   ->  43 live menu entries; 视图/插入/处理/工程/窗口 absent
//   project open -> 270 live menu entries; every one of them present
//
// Every command previously called "inert" responds once a document exists. The
// list below is therefore split by document state, not by command.
//
// Measured on 32.10.0.021. `cw_verify_commands` re-checks on demand.

import { call } from '../bridge/agent.js';
import { documentState } from './track-ui.js';
import { assertCommandAllowed } from './menu.js';

/**
 * Commands that work with no project open — the app-level ones the main frame
 * owns directly.
 */
export const WORKING_NO_PROJECT = [
  { cmdId: 0x882D, hex: '0x882D', name: '编辑 > 参数设置', en: 'Edit > Preferences', effect: 'opens the Preferences dialog' },
  { cmdId: 0xE140, hex: '0xE140', name: '帮助 > 关于 Sonar', en: 'Help > About', effect: 'opens the About dialog' },
  { cmdId: 0xA783, hex: '0xA783', name: 'Cakewalk 助理', en: 'Assistant panel', effect: 'toggles the Assistant / command-palette panel' },
  { cmdId: 0xA798, hex: '0xA798', name: '工具 > 视频引擎设置', en: 'Tools > Video Engine', effect: 'opens the video engine panel' },
  { cmdId: 0x8036, hex: '0x8036', name: '重置 MIDI 和音频', en: 'Reset MIDI and Audio', effect: 'opens a confirmation dialog' },
  { cmdId: 0x80B3, hex: '0x80B3', name: '文件 > 新建', en: 'File > New', effect: 'opens the 新建工程文件 dialog' },
  { cmdId: 0xE101, hex: '0xE101', name: '文件 > 打开', en: 'File > Open', effect: 'opens the file dialog' },
];

/**
 * Additional commands that start working once a project is open. Verified by
 * posting each against a live 16-track project.
 */
export const WORKING_WITH_PROJECT = [
  { cmdId: 0x8294, hex: '0x8294', name: '视图 > 音轨视图', en: 'Views > Track', observed: 'opens the track view (adds HUDNow/HudAimTool windows)' },
  { cmdId: 0x82A6, hex: '0x82A6', name: '插入 > MIDI 轨', en: 'Insert > MIDI Track', observed: 'inserts a MIDI track; the title gains a *' },
  { cmdId: 0x82A5, hex: '0x82A5', name: '插入 > 音频轨', en: 'Insert > Audio Track' },
  { cmdId: 0x8105, hex: '0x8105', name: '视图 > AI Assist', en: 'Views > AI Assist', observed: 'responds (opens the membership panel on a free licence)' },
  { cmdId: 0xA78D, hex: '0xA78D', name: '处理 > 运行 CakeScript 程序', en: 'Process > Run CakeScript', observed: 'responds (opens the membership panel on a free licence)' },
  { cmdId: 0xA797, hex: '0xA797', name: '视图 > CakeScript View', en: 'CakeScript View', observed: 'responds' },
  { cmdId: 0x8029, hex: '0x8029', name: '视图 > 控制台', en: 'Views > Console' },
  { cmdId: 0x8023, hex: '0x8023', name: '视图 > 钢琴卷帘', en: 'Views > Piano Roll' },
  { cmdId: 0x8021, hex: '0x8021', name: '视图 > 事件列表', en: 'Views > Event List' },
  { cmdId: 0x801C, hex: '0x801C', name: '录制', en: 'Record', observed: 'transport; no window change by design' },
  { cmdId: 0x801D, hex: '0x801D', name: '播放/停止', en: 'Play/Stop', observed: 'transport; no window change by design' },
  { cmdId: 0x801F, hex: '0x801F', name: '停止', en: 'Stop', observed: 'transport; no window change by design' },
  { cmdId: 0x8202, hex: '0x8202', name: '静音[取消静音]-全部音轨', en: 'Mute all tracks' },
  { cmdId: 0x8203, hex: '0x8203', name: '独奏[取消独奏]-全部音轨', en: 'Solo all tracks' },
];

/**
 * A caveat that applies to the verification method, not to any command: the
 * window-diff test cannot see a command that changes state without opening a
 * window. Transport (record/play/stop), mute and solo all fall in that class —
 * `none-observed` for them means "no new window", not "nothing happened".
 */
export const WINDOW_DIFF_BLIND_SPOTS = [
  'transport: 录制 / 播放 / 停止 (0x801C-0x801F)',
  'track state: 静音 / 独奏 / 待录 全部音轨 (0x8202-0x8204)',
  'any toggle that only repaints the existing view',
];

/** Re-measure a set of command ids against the running SONAR. */
/**
 * Re-measure a set of command ids against the running SONAR.
 *
 * Cost, MEASURED on this machine: each probe is roughly **15 s**, not the ~2.5 s
 * this comment claimed for several rounds. A probe is two bridge round trips plus
 * a 900 ms settle, and the bridge calls dominate — so the 21-command default set
 * takes about five minutes, not one.
 *
 * That error mattered. It is why the budget default was set to 45 s and then to
 * 12 s, on the assumption that a useful partial would come back quickly; in fact
 * 12 s yields ONE probe and 45 s yields three, neither of which is a survey. There
 * is no budget that makes this tool fast — a partial result here is a different,
 * much weaker claim than a complete one, and `probed` is the field that says which
 * you got.
 *
 * The budget is therefore for a caller who deliberately wants a bounded sample, and
 * the result always names what it did not reach. A caller who wants the measurement
 * should give it the time.
 */
export async function verifyCommands(ids, { budgetMs = 12_000 } = {}) {
  // Survey-only allowlist. Plain runCommand is not limited by this; only this
  // function, which posts commands for real while nobody is watching, is.
  const SAFE = new Set([0x8294, 0x8029, 0x8023, 0x8021, 0x803A, 0x882D, 0xE140]);
  const DEFAULT_IDS = [0x8294, 0x8029];
  const NO_PROJECT = [];

  const doc = await documentState();
  const explicit = Array.isArray(ids);
  const list = explicit
    ? ids
    : doc.projectOpen
      ? DEFAULT_IDS
      : NO_PROJECT;

  const started = Date.now();
  const snap = async () => {
    const s = await call('status');
    const w = s.allWindows;
    return new Set((Array.isArray(w) ? w : w ? [w] : []).map((x) => `${x.cls}|${x.title}`));
  };
  const listOverlays = async () => {
    const res = await call('overlays', {});
    // A bridge failure must surface as an error, not as "no modals open".
    if (res && typeof res === 'object' && res.error) throw new Error(res.error);
    // Actual bridge shape is { overlays: [{ cls: '#32770', title: ... }] };
    // also accept a bare array or a single object.
    const arr = Array.isArray(res)
      ? res
      : res && Array.isArray(res.overlays)
        ? res.overlays
        : res && typeof res === 'object'
          ? [res]
          : [];
    return arr.filter((x) => x && typeof x === 'object' && String(x.cls || x.class) === '#32770');
  };

  const working = [];
  const unchanged = [];
  const errors = [];
  const notProbed = [];
  let budgetExhausted = false;
  let blockedReason;

  for (const cmdId of list) {
    let normalized;
    try {
      // Integers only: never silently truncate a fractional id (0x8294 + 0.5).
      normalized = typeof cmdId === 'number' && Number.isInteger(cmdId)
        ? (cmdId & 0xffff)
        : undefined;
    } catch {
      normalized = undefined;
    }

    if (normalized === undefined || !SAFE.has(normalized)) {
      // Explicit ids outside the allowlist are never posted. Destructive or
      // unknown ids would otherwise be "probing" File > Close and friends.
      notProbed.push({ cmdId, hex: typeof hex === 'function' ? hex(cmdId) : undefined, reason: 'unsafe' });
      continue;
    }

    if (Date.now() - started > budgetMs) {
      budgetExhausted = true;
      notProbed.push({ cmdId: normalized, hex: hex(normalized), reason: 'budget' });
      continue;
    }

    try {
      // Existing policy assertion still runs on every id we would post.
      assertCommandAllowed(normalized, undefined);

      const before = await snap();
      // A modal #32770 left open by someone else would swallow every probe
      // and make it look like the command did nothing.
      if ((await listOverlays()).length) {
        blockedReason = 'modal dialog already open (#32770); refusing to post';
        notProbed.push({ cmdId: normalized, hex: hex(normalized), reason: 'blocked' });
        for (const rest of list.slice(list.indexOf(cmdId) + 1)) {
          const restId = typeof rest === 'number' && Number.isFinite(rest) ? (Math.trunc(rest) & 0xffff) : rest;
          notProbed.push({ cmdId: restId, hex: typeof hex === 'function' ? hex(restId) : undefined, reason: 'blocked' });
        }
        break;
      }

      const posted = await call('runmenu', { cmdId: normalized });
      if (posted && posted.error) throw new Error(posted.error);
      await new Promise((r) => setTimeout(r, 900));

      const after = await snap();
      const added = [...after].filter((x) => !before.has(x));
      if (added.length) {
        working.push({ cmdId: normalized, hex: hex(normalized), opened: added });
      } else {
        unchanged.push({ cmdId: normalized, hex: hex(normalized) });
      }

      // Do NOT close anything for cleanup. If the post produced a new modal,
      // record what we learned and stop; the operator owns that dialog now.
      if ((await listOverlays()).length) {
        blockedReason = 'command opened a modal dialog (#32770); left open, survey stopped';
        const idx = list.indexOf(cmdId);
        for (const rest of list.slice(idx + 1)) {
          const restId = typeof rest === 'number' && Number.isFinite(rest) ? (Math.trunc(rest) & 0xffff) : rest;
          notProbed.push({ cmdId: restId, hex: typeof hex === 'function' ? hex(restId) : undefined, reason: 'blocked' });
        }
        break;
      }
    } catch (e) {
      if (e && e.code === 'NEEDS_CONFIRMATION') {
        notProbed.push({ cmdId: normalized, hex: hex(normalized), reason: 'unsafe' });
      } else {
        errors.push({ cmdId: normalized, hex: hex(normalized), error: e.message });
      }
    }
  }

  return {
    documentOpen: Boolean(doc.projectOpen),
    working,
    unchanged,
    errors,
    // Only commands that were actually posted and observed count as probed.
    // A transport failure is an error, not a measurement.
    probed: working.length + unchanged.length,
    notProbed,
    blocked: blockedReason
      ? { reason: blockedReason }
      : undefined,
    blockedReason,
    budgetMs,
    partial: budgetExhausted || Boolean(blockedReason),
    partialNote: budgetExhausted
      ? `${notProbed.length} command(s) were not probed within the ${budgetMs} ms budget. `
        + 'Pass an explicit cmdIds list to survey a subset, or raise budgetMs.'
      : blockedReason
        ? `${notProbed.length} command(s) were not probed: ${blockedReason}`
        : undefined,
    elapsedMs: Date.now() - started,
    note: 'A command listed under `unchanged` either did nothing or changed state without opening '
      + 'a window — see WINDOW_DIFF_BLIND_SPOTS in lib/commands.js. Transport and mute/solo are '
      + 'expected to appear here even when they worked.',
    blindSpots: WINDOW_DIFF_BLIND_SPOTS,
  };
}

const hex = (n) => '0x' + Number(n).toString(16).toUpperCase();

/**
 * How to drive the commands WM_COMMAND cannot reach — measured, including the
 * parts that failed.
 */
export const UI_RECIPE = {
  menu: {
    reachable: true,
    how: 'Expand a top-level menu item with AXExpand, then click the entry by index.',
    worked: ['文件 > 新建', '工具 > 各条目'],
  },
  keyboard: {
    reachable: 'conditional',
    detail: 'Key events are REFUSED when SONAR is not the frontmost application — the runtime '
      + 'reports frontmost_pid_mismatch and sends nothing. Bring SONAR to the foreground first '
      + '(SetForegroundWindow with an input-thread attach), then typing works: this is how the '
      + 'project name was filled into the new-project dialog.',
  },
  mfcDialogs: {
    reachable: true,
    how: 'Read elements by index; controls are clickable and toggleable.',
    example: 'Preferences > MIDI > 设备: the port rows carry AXToggle and respond to it.',
  },
  juceDialogs: {
    reachable: 'partial',
    how: 'Only the title and close button appear in the tree. Read the form from a screenshot and '
      + 'click by converted coordinate; typing works if SONAR is foreground.',
    example: '新建工程文件: 名称 / 位置 / 模板 list are all invisible to accessibility.',
    caution: 'A JUCE modal blocks the UI thread. While one is open, computer-use calls time out and '
      + 'WM_COMMAND to the main frame is dropped.',
  },
  recovery: {
    symptom: 'computer-use calls time out; WM_COMMAND to the main frame does nothing',
    cause: 'a JUCE modal dialog is holding SONAR\'s UI thread',
    fix: 'Find the dialog hwnd (class matches JUCE_*), then send WM_COMMAND(2 /*IDCANCEL*/), '
      + 'then WM_COMMAND(1 /*IDOK*/), then WM_CLOSE. IDOK is what cleared the stuck dialog in '
      + 'testing; WM_CLOSE alone did nothing.',
  },
  coordinateSpace: {
    detail: 'UIA bounds and SetCursorPos both use physical screen pixels: click the element '
      + 'centre directly, with no scaling. Only raster screenshot coordinates need conversion '
      + 'between screenshot pixels and physical screen pixels.',
  },
};

/** Static summary for cw_command_support. */
export async function commandSupportSummary() {
  const doc = await documentState();
  return {
    build: 'measured on 32.10.0.021',
    documentOpen: doc.projectOpen,
    worksNow: doc.projectOpen ? WORKING_WITH_PROJECT : [],
    worksAlways: WORKING_NO_PROJECT,
    explanation:
      'Whether a command responds depends on whether a project is open, not on the command. With '
      + 'no document the menu bar has 43 entries and only the app-level commands work; with a '
      + 'project open it has 270 and the 视图 / 插入 / 处理 / 工程 / 窗口 menus and their commands '
      + 'all respond. An earlier measurement without a document wrongly read this as "the build '
      + 'registers these commands without handlers".',
    verificationCaveat:
      'The window-diff test cannot see a command that changes state without opening a window. '
      + 'Transport and mute/solo appear as "unchanged" even when they worked.',
    blindSpots: WINDOW_DIFF_BLIND_SPOTS,
    uiRecipe: UI_RECIPE,
  };
}
