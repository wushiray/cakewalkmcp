// lib/track-ui.js — reading and writing SONAR's Track view controls.
//
// Written from measurement on 32.10.0.021, with a 16-track project open.
//
// This file previously recorded three conclusions. Two were wrong and one was
// half right, and since the wrong ones were load-bearing — they are why six
// tools sat dead — they are corrected here rather than quietly dropped.
//
// CORRECTION 1. "A plain process cannot reach any of it — UIA from outside the
// computer-use runtime sees 2 elements for the same window."
//
// False. Measured with a project open, a plain UIA client sees 139 descendants
// for the SONAR window and 82 of them are track controls, each with bounds and a
// live value. The "2 elements" figure was taken with no project open, when the
// track strips do not exist yet. Nothing outside a computer-use runtime was ever
// needed; `native/uia/cw_uia.ps1` is the plain client that proves it.
//
// CORRECTION 2. "Writing does not work. Controls advertise AXSetValue / AXToggle
// / AXPress and the runtime accepts the call, but the value does not change."
//
// Half right, and the wrong half mattered. The ACCESSIBILITY ACTIONS are indeed
// inert — re-confirmed on 手动静音, where AXPress and AXToggle each return
// success and leave the value at 关闭. But a REAL mouse event at the element's
// own centre does change it, and the change is visible in the element's value
// afterwards. So the pattern is: locate by name through accessibility, act with
// a genuine click, verify through accessibility. Writing works.
//
// CORRECTION 3. "Element bounds are in WINDOW space (1920x902) while a click
// needs FRAME space (1280x601). Divide by 1920/1280."
//
// Only true if you are clicking through a computer-use runtime's captured
// raster, which is the window downscaled. UIA BoundingRectangle and
// SetCursorPos are both PHYSICAL SCREEN pixels and agree directly — provided the
// clicking process calls SetProcessDPIAware. Without it, coordinates are
// virtualised by the DPI scale and every click lands 1.5x off on a 150% display,
// which reads as "the control ignores clicks". See boundsToClick below.
//
// What remains from the original notes, still measured and still true:
//
//   no project   ->  33-37 elements (menu bar, toolbar captions, pane names)
//                    menu bar has only 文件/编辑/工具/帮助
//   project open ->  173 elements, including every track control
//                    270 menu entries across 文件/编辑/视图/插入/处理/工程/工具/窗口/帮助
//
// So anything described as "the command does nothing" has to be re-read as "the
// command does nothing *with no project open*".
//
// The controls are named "<label> on Track <N>":
//
//   slider  "音量 on Track 17"    = "101"           actions=[AXSetValue]
//   slider  "声像 on Track 17"    = "0% 中"          actions=[AXSetValue]
//   button  "手动静音 on Track 17" = "关闭"           actions=[AXToggle,AXPress]  WRITABLE
//   button  "独奏 on Track 17"    = "关闭"           actions=[AXToggle,AXPress]  WRITABLE
//   button  "录制 on Track 17"    = "关闭"           actions=[AXToggle,AXPress]  WRITABLE
//   button  "输出 on Track 17"    = "1-Steinberg UR22C-1"
//   button  "输入 on Track 17"    = "全通道"
//
// A value read back immediately after a click is reliable when it is read from a
// FRESH element (the tree is rebuilt on a state change); re-reading a stale
// AutomationElement can return the old value.

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { runCommand } from './menu.js';
import { call } from '../bridge/agent.js';

/** Per-track controls. `readable` is measured; `writable` is what we found. */
export const TRACK_CONTROLS = [
  // MIDI strips (CTVMIDITRACKSTRIP)
  { label: '音量', kind: 'slider', appliesTo: ['midi', 'audio'], read: 'numeric, e.g. "101"' },
  { label: '声像', kind: 'slider', appliesTo: ['midi', 'audio'], read: 'e.g. "0% 中"' },
  { label: '力度+', kind: 'slider', appliesTo: ['midi'], read: 'numeric' },
  { label: '音色', kind: 'button', appliesTo: ['midi'], read: 'patch name or 无' },
  { label: 'MIDI 通道', kind: 'button', appliesTo: ['midi'], read: 'channel or 无' },
  { label: '音色库', kind: 'button', appliesTo: ['midi'], read: 'bank or 无' },
  // audio strips (CTVAUDIOTRACKSTRIP)
  { label: '增益', kind: 'slider', appliesTo: ['audio'], read: 'numeric' },
  { label: '插值', kind: 'button', appliesTo: ['audio'], read: 'e.g. 立体声' },
  { label: '相位', kind: 'button', appliesTo: ['audio'], read: 'e.g. 普通' },
  { label: '波形预览', kind: 'button', appliesTo: ['audio'], read: '关闭/打开' },
  // shared
  { label: '输入', kind: 'button', appliesTo: ['midi', 'audio'], read: 'port name, 全通道, or -无-' },
  { label: '输出', kind: 'button', appliesTo: ['midi', 'audio'], read: 'port or bus name' },
  { label: '录制', kind: 'button', appliesTo: ['midi', 'audio'], read: '关闭/打开' },
  { label: '独奏', kind: 'button', appliesTo: ['midi', 'audio'], read: '关闭/打开' },
  { label: '手动静音', kind: 'button', appliesTo: ['midi', 'audio'], read: '关闭/打开' },
  { label: '自动控制的静音', kind: 'button', appliesTo: ['midi', 'audio'], read: '关闭/打开' },
  { label: '输入反馈', kind: 'button', appliesTo: ['midi', 'audio'], read: '自动路由/关' },
  { label: '冻结', kind: 'button', appliesTo: ['midi', 'audio'], read: '' },
  { label: '存档', kind: 'button', appliesTo: ['midi', 'audio'], read: '关闭/打开' },
  { label: '自动控制读取', kind: 'button', appliesTo: ['midi', 'audio'], read: '打开/关闭' },
  { label: '自动控制写入', kind: 'button', appliesTo: ['midi', 'audio'], read: '打开/关闭' },
];

export const CONTAINERS = {
  midiStrip: 'CTVMIDITRACKSTRIP',
  audioStrip: 'CTVAUDIOTRACKSTRIP',
  clipsView: 'CCLIPSVIEW',
  trackView: 'CTRACKVIEW',
  ruler: 'CXTIMERULERVIEW',
  propsHeader: 'CTRACKPROPSHEADERVIEW',
  trackBar: 'CTVCONTROLBAR',
  controlBar: 'CCTRLBAR',
  // The Track view's own toolbar: 视图 / 选项 / 音轨 / 剪辑 / MIDI / Region FX, then a group of
  // unlabelled icon buttons that toggle which columns the strips show. These DO carry
  // accessibility elements with bounds and AXPress — the only track-view chrome that does.
  trackContextBar: ['视图', '选项', '音轨', '剪辑', 'MIDI ', 'Region FX'],
  modules: ['CCTRLBARPUNCHMODULE', 'CCTRLBARMIXMODULE', 'CCTRLBARLOOPMODULE',
    'CCTRLBARPERFORMANCEMODULE', 'CCTRLBARSELECTMODULE', 'CCTRLBARSCREENSETMODULE',
    'CCTRLBARACTMODULE', 'CCTRLBARMARKERSMODULE', 'CCTRLBAREVENTINSPECTORMODULE',
    'CCTRLBARSYNCMODULE', 'CCTRLBARCUSTOMMODULE', 'CCTRLBARMIXRECALLMODULE'],
};

/**
 * Views that can be opened with a command id. Verified by screenshot, because a
 * window diff cannot see a view that opens inside the existing frame — that is
 * why these all report `none-observed` through cw_run_command yet do work.
 */
export const VIEW_COMMANDS = {
  trackView: { cmdId: 0x8294, hex: '0x8294', name: '视图 > 音轨视图', note: 'the default view' },
  console: { cmdId: 0x8029, hex: '0x8029', name: '视图 > 控制台' },
  pianoRoll: { cmdId: 0x8023, hex: '0x8023', name: '视图 > 钢琴卷帘' },
  eventList: { cmdId: 0x8021, hex: '0x8021', name: '视图 > 事件列表',
    note: 'tabular — the surface to read notes from, if note-level reading is needed' },
  synthRack: { cmdId: 0x81C4, hex: '0x81C4', name: '视图 > 音源架视图',
    note: 'opens a rack pane in the Track view. Verified visually. Its slot toolbar (+ / delete / '
      + 'settings / output selector) carries no accessibility elements, so the pane can be opened '
      + 'and seen but not driven.' },
  markers: { cmdId: 0x803A, hex: '0x803A', name: '视图 > 标记' },
  staff: { cmdId: 0x806B, hex: '0x806B', name: '视图 > 乐谱' },
  browser: { cmdId: 0x8A59, hex: '0x8A59', name: '查看插件',
    note: 'not a view but the plugin browser — same category of surface' },
};

/** The exact element name to look for. */
export const controlName = (label, trackIndex) => `${label} on Track ${trackIndex}`;

/** The track-name element, e.g. "音轨 17 on Track 17". */
export const trackNameElement = (trackIndex) => `音轨 ${trackIndex} on Track ${trackIndex}`;

/**
 * Controls the adapter can WRITE, and the wording their values carry.
 *
 * Each of these was toggled both ways and read back changed, so `writable` is a
 * measurement rather than a guess. The `on`/`off` strings are this build's
 * wording: 打开 and 关闭.
 */
export const WRITABLE_CONTROLS = {
  mute: { label: '手动静音', on: '打开', off: '关闭', note: 'manual mute, not automation mute' },
  solo: { label: '独奏', on: '打开', off: '关闭' },
  arm: { label: '录制', on: '打开', off: '关闭' },
};

/**
 * Convert an element's UIA bounds to click coordinates.
 *
 * Returns the centre unchanged: both are physical screen pixels, so the honest
 * conversion is none at all. It exists as a named function because the old note
 * here said to divide by the DPI scale, and callers written against that are
 * wrong by exactly the scale factor.
 *
 * `forRaster` converts for a computer-use raster instead — that IS downscaled
 * from the window, so there the division is correct. Kept separate so the two
 * cases cannot be confused again.
 */
export function boundsToClick(bounds) {
  if (!Array.isArray(bounds) || bounds[2] <= 0) return null;
  const [x, y, w, h] = bounds;
  return [Math.round(x + w / 2), Math.round(y + h / 2)];
}

export function boundsToRaster(bounds, windowWidth, rasterWidth) {
  const c = boundsToClick(bounds);
  if (!c || !rasterWidth) return null;
  const s = windowWidth / rasterWidth;
  return [Math.round(c[0] / s), Math.round(c[1] / s)];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const UIA_SCRIPT = join(HERE, '..', 'native', 'uia', 'cw_uia.ps1');

/**
 * Run the accessibility helper and parse its JSON.
 *
 * The helper is PowerShell because that is where UIAutomationClient and a
 * DPI-aware SetCursorPos are both reachable without a build step. It prints one
 * JSON object on stdout; anything else on stderr means the run failed.
 */
function runUia(args, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_SCRIPT, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
      (err, stdoutBuf, stderrBuf) => {
        // PowerShell 5.1 writes non-ASCII on the console code page (GBK here).
        // Decoding those bytes as UTF-8 produced mojibake in every Chinese error
        // message; fall back to GBK when the UTF-8 decode lost bytes.
        const decode = (b) => {
          if (!b || !b.length) return '';
          const buf = Buffer.from(b);
          const utf8 = buf.toString('utf8');
          if (!utf8.includes('�')) return utf8;
          try { return new TextDecoder('gbk').decode(buf); } catch (_) { return utf8; }
        };
        const stdout = decode(stdoutBuf);
        const stderr = decode(stderrBuf);
        const text = (stdout || '').trim();
        if (!text) {
          return reject(new Error(
            err ? `UIA helper failed: ${(stderr || err.message || '').trim().slice(0, 400)}`
                : 'UIA helper produced no output'));
        }
        let parsed;
        try { parsed = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop()); }
        catch (e) { return reject(new Error(`UIA helper returned non-JSON: ${text.slice(0, 300)}`)); }
        if (parsed && parsed.ok === false) {
          return reject(Object.assign(new Error(parsed.error || 'UIA helper reported failure'),
            { detail: parsed, hint: parsed.hint }));
        }
        resolve(parsed);
      });
  });
}

/**
 * Read one track control's current value and position.
 *
 * `label` is a control label; the caller may pass a WRITABLE_CONTROLS key
 * ('mute' | 'solo' | 'arm') for convenience, since those are what the tools use.
 */
export async function readTrackControl(labelOrKey, trackIndex) {
  const label = WRITABLE_CONTROLS[labelOrKey] ? WRITABLE_CONTROLS[labelOrKey].label : labelOrKey;
  const r = await runUia(['-Action', 'find', '-Label', label, '-Track', String(trackIndex)]);
  return { label, track: trackIndex, value: r.valueText, bounds: [r.x, r.y, r.w, r.h],
           click: [r.cx, r.cy], type: r.type, enabled: r.enabled };
}

/**
 * Set a track control to a state, by clicking it, and confirm from the re-read.
 *
 * The click is a genuine mouse event, not an accessibility action — see the
 * correction at the top of this file for why that distinction is the whole
 * mechanism. `verified` is the part callers should trust: it is true only when
 * the value read back equals the requested one.
 */
export async function setTrackControl(key, trackIndex, on) {
  const def = WRITABLE_CONTROLS[key];
  if (!def) throw new Error(`not a writable track control: ${key}`);
  const r = await runUia(['-Action', 'set', '-Label', def.label, '-Track', String(trackIndex),
                          '-On', on ? '1' : '0']);
  if (r.ok === false) throw new Error(r.error);
  return {
    control: key, label: def.label, track: trackIndex,
    requested: on ? def.on : def.off,
    before: r.before, after: r.after,
    clicked: r.clicked || null,
    // How many clicks the helper had to spend. 0 means the control was already
    // in the requested state; 2 means the first click did not land, which is
    // normal for the first synthesised click of a run — it can be consumed
    // activating the window.
    attempts: r.attempts,
    changed: r.changed,
    // True when the control was already in the requested state — an idempotent
    // write is a success, and a caller that read `changed === false` as failure
    // would retry forever.
    alreadyThere: !!r.alreadyThere,
    verified: !!r.verified,
    ...(r.verified ? {} : { warning: 'the value did not land on the requested state' }),
  };
}

/** Toggle a control without asserting a direction. */
export async function toggleTrackControl(key, trackIndex) {
  const def = WRITABLE_CONTROLS[key];
  if (!def) throw new Error(`not a writable track control: ${key}`);
  const r = await runUia(['-Action', 'toggle', '-Label', def.label, '-Track', String(trackIndex)]);
  return { control: key, track: trackIndex, before: r.before, after: r.after,
           changed: r.changed, verified: r.verified };
}

/**
 * Every track control currently on screen, with its value and position.
 *
 * Only tracks visible in the Track view appear — a scrolled-away track has no
 * elements at all. That is worth stating because "no element" and "no such
 * control" otherwise look identical, and they need different fixes.
 */
function dumpLabelOf(c) {
  // The helper may report either `label` (already the bare label) or `name`
  // (the full "<label> on Track <N>" element name). Prefer `label`; the stored
  // `label` here NEVER carries " on Track N" — only `name` below does.
  if (typeof c.label === 'string' && c.label) {
    return c.label.replace(/ on Track \d+$/, '');
  }
  const raw = typeof c.name === 'string' ? c.name :
    (typeof c.Name === 'string' ? c.Name : '');
  const cut = raw.lastIndexOf(' on Track ');
  if (cut >= 0) return raw.slice(0, cut);
  return raw.replace(/ on Track \d+$/, '');
}

function dumpTrackOf(c, label) {
  // The track index is taken from the explicit field when present, otherwise
  // reconstructed from the " on Track <N>" suffix of the raw element name.
  if (c.track !== undefined && c.track !== null && c.track !== '') return c.track;
  const raw = typeof c.name === 'string' ? c.name :
    (typeof c.Name === 'string' ? c.Name : '');
  const m = raw.match(/ on Track (\d+)$/);
  if (m) return Number(m[1]);
  if (label === '') return null;
  return null;
}

export async function dumpTrackControls() {
  const r = await runUia(['-Action', 'dump'], { timeoutMs: 40000 });
  return r.controls.map(c => {
    const label = dumpLabelOf(c);
    const track = dumpTrackOf(c, label);
    const value = c.valueText !== undefined ? c.valueText : c.value;
    return {
      // `label` is the bare control label, with NO " on Track N" suffix.
      label,
      // `track` is the strip's track number.
      track,
      // `name` is rebuilt as "<label> on Track <track>" so that every consumer
      // sees a stable element name regardless of which field the helper emitted.
      name: `${label} on Track ${track}`,
      value,
      bounds: [c.x, c.y, c.w, c.h], click: [c.cx, c.cy],
    };
  });
}

/** Which track numbers the Track view is currently showing controls for. */
export async function visibleTracks() {
  const r = await runUia(['-Action', 'listtracks']);
  return r.tracks;
}

/**
 * Rename a track by editing its strip's name field.
 *
 * Unlike the three toggles this is not a single click: it is a double-click to
 * open the editor, a paste, and Enter. The paste goes through the clipboard
 * rather than typed keys because SendKeys cannot enter Chinese, and track names
 * here usually are Chinese.
 *
 * Verified by reading the element name back, which is the only confirmation
 * available — the strip's name field *is* the track name, so a rename shows up as
 * the old element disappearing and a new one appearing.
 *
 * This replaces the CakeScript route (`setTrackName`), which is unavailable on
 * builds without the AI Assistant panel.
 *
 * SIDE EFFECT, disclosed: the rename pastes through the system clipboard, so
 * whatever the user had copied is overwritten. It is not saved or restored —
 * silently saving and restoring clipboard state has its own failure modes
 * (non-text clipboard formats cannot be round-tripped) and was judged worse
 * than the visible, transient overwrite.
 */
/**
 * KNOWN LIMIT, measured: renaming works on normal tracks (audio and MIDI) and was
 * verified both ways with ASCII and Chinese. On a soft-synth track — the
 * multi-out piano strip 'SI-Electric Piano 1' is the measured case — the name
 * field renders inside a larger custom control and the double-click selects
 * instead of editing, tried twice. The helper now clicks once more after the
 * double-click, which covers strips that need a nudge, and reports verified
 * honestly when none of it lands. Use the T1 route (CakeScript) where available
 * for such tracks.
 */
export async function renameTrack(trackIndex, name) {
  const r = await runUia(['-Action', 'rename', '-Track', String(trackIndex), '-Text', name],
                         { timeoutMs: 30000 });
  return {
    track: trackIndex,
    requested: name,
    before: r.before, after: r.after,
    clicked: r.clicked || null,
    changed: r.changed,
    alreadyThere: !!r.alreadyThere,
    verified: !!r.verified,
    ...(r.verified ? {} : { warning: `the name did not land on ${JSON.stringify(name)}` }),
  };
}

/**
 * The state of the document, decided from the window title — the one piece of
 * project state this process CAN see, because Win32 exposes the caption even
 * when it exposes nothing inside.
 *
 * SONAR uses two title shapes, and recognising only the first caused a real
 * false negative (a loaded .mid reported as "no project open", which then
 * skipped every view test on it):
 *
 *   "Cakewalk Sonar"                      -> no document
 *   "Cakewalk Sonar - [name.cwp]"         -> .cwp open, saved
 *   "Cakewalk Sonar - [name.cwp*]"        -> .cwp open, modified
 *   "name.mid - Cakewalk Sonar"           -> a non-.cwp document (imported MIDI)
 */
export async function documentState() {
  let title = null;
  let bridgeError = null;
  try {
    const s = await call('status');
    title = s && s.sonar && s.sonar.title ? s.sonar.title : null;
  } catch (e) {
    // Distinguish "the bridge died" from "SONAR is closed". Reporting a bridge
    // failure as "SONAR is not running" sent the user to restart the wrong app.
    bridgeError = e && e.message ? e.message : String(e);
  }

  if (!title) {
    return {
      known: false,
      reason: bridgeError
        ? `the PowerShell bridge is unavailable: ${bridgeError}`
        : 'SONAR not reachable, or it is not running.',
      ...(bridgeError ? { bridgeError: true } : {}),
    };
  }
  return classifyTitle(title);
}

/**
 * Classify a main-window caption. Pure — the caption in, the state out.
 *
 * Split out from documentState() because the classification is string logic and
 * has nothing to do with calling the bridge, yet testing it used to require
 * going through a live process. Every title shape this build produces is worth
 * pinning, and now that costs no process at all:
 *
 *   "Cakewalk Sonar"                      -> no document
 *   "Cakewalk Sonar - [name.cwp]"         -> .cwp open, saved
 *   "Cakewalk Sonar - [name.cwp*]"        -> .cwp open, modified
 *   "name.mid - Cakewalk Sonar"           -> a non-.cwp document (imported MIDI)
 */
export function classifyTitle(rawTitle) {
  // SONAR appends its activation state to the caption. Measured on a clean,
  // unlicensed reinstall: the caption read
  //
  //     baseline.mid - Cakewalk Sonar [未激活]
  //
  // Every shape below expects the caption to END with the product name or the
  // document, so the marker made a loaded project look like no project at all:
  // documentState reported projectOpen:false, t5 stayed degraded, and every
  // track tool refused to run. The marker is stripped for MATCHING only — the
  // original caption is returned untouched.
  const title = String(rawTitle).replace(/\s*\[(?:未激活|已激活|not\s+activated|activated)\]\s*$/i, '').trim();
  const caption = rawTitle;

  // Shape 1: the product name leads and the document sits in brackets.
  const bracketed = title.match(/^.*?\s*-\s*\[(.+?)(\*)?\]\s*$/);
  if (bracketed) {
    return {
      known: true,
      projectOpen: true,
      project: bracketed[1],
      modified: Boolean(bracketed[2]),
      documentKind: /\.cwp$/i.test(bracketed[1]) ? 'cakewalk-project' : 'imported',
      title: caption,
      note: 'A project is open, so the full menu tree and the track control elements exist. '
        + 'Read or drive them per cw_track_controls.',
    };
  }

  // Shape 2: the document name leads and the product name trails. Used when a
  // non-.cwp file (a .mid import) is loaded.
  const trailing = title.match(/^(.+?)\s*-\s*Cakewalk Sonar\s*$/i);
  if (trailing) {
    return {
      known: true,
      projectOpen: true,
      project: trailing[1],
      modified: trailing[1].includes('*'),
      documentKind: 'imported',
      title: caption,
      note: 'A non-.cwp document is open (typically an imported MIDI file). The full menu tree and '
        + 'track strips exist; the track parameters reflect what the file carried (CC7/CC10 become '
        + 'volume and pan).',
    };
  }

  return {
    known: true,
    projectOpen: false,
    title: caption,
    note: 'No document in the title, so no project is open. The menu bar is limited to the '
      + 'application-level menus and the track strips do not exist — which is exactly why view '
      + 'and document commands appear to do nothing on a fresh SONAR, and why an earlier round '
      + 'wrongly concluded CakeScript had been removed.',
    hint: 'Open a project. 文件 > 新建 is 0x80B3; it opens the 新建工程文件 dialog, which is JUCE '
      + 'and must be completed with clicks and typing (see cw_ui_recipe). To load a file instead, '
      + '0xE101 (文件 > 打开) opens a standard MFC dialog whose filename field accepts AXSetValue.',
  };
}

/** What an agent should do, given the document state. */
export async function trackAccessPlan() {
  const doc = await documentState();
  const base = {
    document: doc,
    naming: {
      control: '"<label> on Track <N>" — e.g. 音量 on Track 3, 录制 on Track 3',
      trackName: '音轨 <N> on Track <N>',
      stripType: `midi=${CONTAINERS.midiStrip}, audio=${CONTAINERS.audioStrip}`,
    },
    reading: {
      works: true,
      detail: 'Element values are accurate snapshots of track state: volume, pan, routing, and the '
        + 'mute/solo/arm flags. Read them directly.',
    },
    writing: {
      works: true,
      controls: Object.keys(WRITABLE_CONTROLS),
      detail: 'Writing works, but not through the accessibility actions: those are accepted and do '
        + 'nothing. A real mouse event at the element centre does change the control, and the value '
        + 'then reads back changed. The adapter does this itself via native/uia/cw_uia.ps1 — '
        + 'cw_set_track_mute / solo / arm use it and report `verified` from the read-back.',
      needed: 'A project must be open, and the track must be VISIBLE in the Track view. A track '
        + 'scrolled out of the view is refused rather than clicked: SONAR still reports a '
        + 'BoundingRectangle for it and still reports IsOffscreen false, so a blind click lands on '
        + 'whatever the window shows there. The guard is geometric, against the CTRACKVIEW rect.',
      notWritable: 'Sliders (音量 / 声像 / 增益) and the routing buttons (输入 / 输出) open controls '
        + 'that this path does not drive: the sliders take a value through a pattern that SONAR '
        + 'ignores, and the routing buttons open a picker. Use cw_midi_* for volume and pan.',
    },
    coordinates:
      'UIA bounds and SetCursorPos are both PHYSICAL screen pixels, so the click uses the element '
      + 'centre unchanged — see boundsToClick. Only a computer-use raster needs dividing down, since '
      + 'that is the window rescaled; use boundsToRaster for that. The clicking process must be '
      + 'DPI-aware or coordinates are virtualised and every click lands 1.5x off on a 150% display.',
    staleness:
      'Read the value from a FRESH element. The tree is rebuilt when a control changes state, and '
      + 're-reading a cached AutomationElement can return the old value.',
    reachability:
      'A plain UIA client sees these elements — 139 descendants and 82 track controls with a project '
      + 'open, measured with PowerShell, no computer-use runtime involved. An earlier note here '
      + 'claimed "a plain UIA client sees 2 elements"; that was measured with no project open.',
  };
  if (!doc.projectOpen) {
    return {
      ...base,
      ready: false,
      first: 'Open a project first — the track strips do not exist until one is open. '
        + 'cw_run_command with 0x80B3 (文件 > 新建) or 0xE101 (文件 > 打开).',
    };
  }
  let visible = [];
  try { visible = await visibleTracks(); } catch (_) { /* report none rather than fail */ }
  return {
    ...base,
    ready: true,
    controls: TRACK_CONTROLS,
    containers: CONTAINERS,
    writable: WRITABLE_CONTROLS,
    visibleTracks: visible,
  };
}

// --- track templates ---------------------------------------------------------
//
// A .cwx track template is a whole pre-built strip: instrument, FX chain, sends,
// routing. It is the one *verifiable* way this adapter can put a plug-in chain
// into a project.
//
// Why not the Plug-ins pane directly, which shows all 275 of them? Because that
// tree is DRAWN, not exposed: measured with the browser open, the pane contains
// no accessibility elements at all — no names, no values, nothing to read back.
// Driving it would mean clicking coordinates on a picture with no way to confirm
// which plug-in landed, and a mis-click would insert the wrong one silently.
//
// The template route has none of that problem. 插入 > 音轨模板 opens a standard
// MFC file dialog, and standard controls DO honour setValue and Invoke — so the
// path is typed in and confirmed, and the result is checked by finding the new
// track's name in the strip accessibility tree.

/** Where SONAR keeps track templates. Both roots exist on this machine. */
// Deployment roots for track templates. The first two are this machine's
// install layout; the ProgramData one is the standard per-machine location.
// CW_TEMPLATE_ROOTS (path-separator-delimited) overrides or extends the list,
// so a deployment on a different drive is a config change, not a code edit.
const DEFAULT_TEMPLATE_ROOTS = [
  'D:/CAKEWALK/Cakewalk Content/Sonar/Track Templates',
  'D:/CAKEWALK/Cakewalk Content/Cakewalk Core/Track Templates',
  'C:/ProgramData/Cakewalk/Cakewalk Content/Sonar/Track Templates',
];

// Backslashes to forward slashes, trailing slash dropped.
const normalizeRoot = (r) => String(r).split(String.fromCharCode(92)).join('/').replace(/\/$/, '');

/**
 * Compute the template roots for THIS call.
 *
 * Deliberately a function and not a module-level constant: CW_TEMPLATE_ROOTS and
 * the registry ContentDir both change while the process is alive, so a root
 * configured or installed after import must be picked up by the very next list
 * call rather than never. Reading them at import time also spawned a registry
 * query as a side effect of merely importing this module.
 *
 * Order: environment, then registry, then the static defaults. Normalised and
 * deduplicated, because the registry folder and the hard-coded one are usually
 * the same folder and without that every template was listed twice.
 */
function makeContentDirRoots() {
  const envRoots = process.env.CW_TEMPLATE_ROOTS
    ? process.env.CW_TEMPLATE_ROOTS.split(/[;|]/).filter(Boolean)
    : [];
  const registryRoots = contentDirRoots();
  return [...new Set([...envRoots, ...registryRoots, ...DEFAULT_TEMPLATE_ROOTS].map(normalizeRoot))];
}

// A real array, exported so callers can index, spread and compare `.length`.
// It starts as the static defaults only (no env, no registry, no process spawn
// at import) and is refreshed in place by refreshTemplateRoots() at list time.
export const TEMPLATE_ROOTS = [...new Set(DEFAULT_TEMPLATE_ROOTS.map(normalizeRoot))];

/** Replace the contents of the exported array in place, keeping references valid. */
function refreshTemplateRoots() {
  TEMPLATE_ROOTS.splice(0, TEMPLATE_ROOTS.length, ...makeContentDirRoots());
  return TEMPLATE_ROOTS;
}

/**
 * Ask the registry where SONAR's content is. Read at call time, not at import
 * time, so a SONAR installed after this process started is still found.
 */
function contentDirRoots() {
  const out = [];
  // reg.exe rather than a PowerShell one-liner: passing a registry path with
  // backslashes through -Command and through cmd.exe's quote handling lost it
  // twice, and the failure was silent (an empty result, not an error).
  const B = String.fromCharCode(92);
  const keys = [
    'HKLM' + B + 'SOFTWARE' + B + 'Cakewalk Music Software',
    'HKLM' + B + 'SOFTWARE' + B + 'WOW6432Node' + B + 'Cakewalk Music Software',
  ];
  for (const key of keys) {
    let text = '';
    try {
      text = execFileSync('reg.exe', ['query', key, '/v', 'ContentDir'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) { continue; }
    const m = text.match(/ContentDir\s+REG_SZ\s+(.+)/);
    if (!m) continue;
    const dir = m[1].trim().split(String.fromCharCode(92)).join('/').replace(/\/$/, '');
    out.push(dir + '/Sonar/Track Templates');
    out.push(dir + '/Cakewalk Core/Track Templates');
  }
  return out;
}

/**
 * Every .cwx template found on disk, with its category path.
 *
 * Read from the filesystem rather than from the dialog, because the dialog only
 * ever shows the folder it is currently in — the same reason the picker cannot
 * be asked "what is available".
 */
export function listTrackTemplates() {
  // Fresh environment + registry + static defaults for THIS call; the previous
  // call's environment is not carried forward.
  const roots = refreshTemplateRoots();
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!/\.cwx$/i.test(e.name)) continue;
        out.push({
          name: e.name.replace(/\.cwx$/i, ''),
          file: full,
          category: (() => {
            const bs = String.fromCharCode(92);
            const rel = full.split(bs).join('/').slice(root.length + 1);
            const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf(bs));
            return cut < 0 ? '.' : rel.slice(0, cut);
          })(),
          bytes: (() => { try { return statSync(full).size; } catch { return null; } })(),
        });
      }
    };
    walk(root, 0);
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** Find a template by name (exact, then case-insensitive, then substring). */
export function findTrackTemplate(name) {
  const all = listTrackTemplates();
  const exact = all.filter(t => t.name === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`"${name}" matches ${exact.length} templates; use the full path`);
  const wanted = String(name).toLowerCase();
  const ci = all.filter(t => t.name.toLowerCase() === wanted);
  if (ci.length === 1) return ci[0];
  if (ci.length > 1) throw new Error(`"${name}" matches ${ci.length} templates; use the full path`);
  // Substring match is case-insensitive on BOTH sides: a template stored as
  // "SI-Electric Piano 1" must be found by "electric". More than one hit is
  // ambiguous, never a silent first-match.
  const sub = all.filter(t => t.name.toLowerCase().includes(wanted));
  if (sub.length === 1) return sub[0];
  if (sub.length === 0) throw new Error(`no track template named "${name}"`);
  throw new Error(`"${name}" is ambiguous: ${sub.map(t => t.name).join(', ')}`);
}

/**
 * Insert a track template, and confirm the new track by name.
 *
 * THE DIALOG MUST ALREADY BE OPEN. This drives 导入音轨模板; it does not open it,
 * because opening it reliably is not possible from here:
 *
 *   - Posting WM_COMMAND 0x8536 (插入 > 音轨模板) works sometimes and silently does
 *     nothing other times. Document-scoped commands on this build are registered
 *     and not always dispatched — the same finding already recorded for the 视图
 *     menu.
 *   - Clicking the 插入 menu-bar item does not help. SONAR's menu bar exposes
 *     accessibility names that do not match what is drawn: clicking the element
 *     named 插入(I) lands on 选项. Index-based clicking is reliable for the track
 *     strips and not for the menu bar — measured, after an earlier attempt to
 *     convert coordinates went wrong in the other direction.
 *
 * So the division of labour is: open the dialog from the menu (two clicks), then
 * call this. Everything after that point is scripted and confirmed. When the
 * dialog is not open the error says so rather than blaming the template.
 *
 * Confirmation is by name: SONAR names the created strip after the template, so
 * finding `"<template> on Track <N>"` in the strip tree is a real check. The new
 * track may land below the visible area when a project has many tracks, in which
 * case `verified` is false and the warning says to scroll; the insert still
 * happened, so that is not reported as failure.
 */
export async function insertTrackTemplate(nameOrPath, { timeoutMs = 40000, openDialog = false } = {}) {
  // A full path (either separator) that exists on disk is used directly; a bare
  // name goes through the template lookup.
  const rawName = typeof nameOrPath === 'string' ? nameOrPath : String(nameOrPath);
  const tpl = /[\\/]/.test(rawName) && existsSync(rawName)
    ? { name: rawName.replace(/^.*[\\/]/, '').replace(/\.cwx$/i, ''), file: rawName }
    : findTrackTemplate(rawName);

  // Snapshot the track IDs that already exist. IDs the Track view could not
  // report (no track number) are dropped rather than counted as one shared value.
  const seenTracks = new Set();
  for (const c of await dumpTrackControls()) {
    if (c.track !== null && c.track !== undefined && c.track !== '') seenTracks.add(c.track);
  }

  if (openDialog) await runCommand(0x8536);       // may or may not land; see above

  const r = await runUia(['-Action', 'inserttemplate', '-Text', tpl.file], { timeoutMs });
  if (r.ok === false) throw Object.assign(new Error(r.error), { hint: r.hint });

  // Verification is two conditions together: an element whose LABEL equals the
  // template name (the label never carries the " on Track N" suffix), AND a
  // track ID that was not in the snapshot. A strip that already matched before
  // the insert cannot prove a new track appeared — only a new ID can.
  let found = null;
  for (let i = 0; i < 8 && !found; i++) {
    await new Promise(res => setTimeout(res, 700));
    const all = await dumpTrackControls();
    found = all.find(c => c.label === tpl.name
      && c.track !== null && c.track !== undefined && c.track !== ''
      && !seenTracks.has(c.track)) || null;
  }
  return {
    template: tpl.name,
    file: tpl.file,
    track: found ? found.track : null,
    verified: !!found,
    ...(found ? {} : {
      warning: 'the template was opened, but no track with its name appeared under a new track id '
        + 'in the Track view — scroll down to confirm. Insertion is not treated as failed on that '
        + 'basis alone.',
      tracksSeenBefore: seenTracks.size,
    }),
  };
}
