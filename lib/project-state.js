// lib/project-state.js — project state on builds with no CakeScript transport.
//
// Why this is not a plain read: SONAR 2026.10 draws its client area with
// JUCE/Direct2D and exposes nothing about project content through any
// automation interface. Verified on 32.10.0.021:
//
//   * WM_GETTEXT on every window SONAR owns returns an empty string — even the
//     frame titled "Cakewalk Sonar" reports its title but no track, clip or
//     mixer text anywhere.
//   * UIA TreeScope::Descendants over the main window yields 19 elements, all
//     containers (MDIClient, AfxControlBar140u, the CCtrlBar* panes, the JUCE
//     shell). No tracks, clips, faders or meters. Deep traversal adds nothing.
//   * MSAA (AccessibleObjectFromWindow / OBJID_CLIENT) reaches the control bars
//     and at most 16 children, again only chrome.
//   * A computer-use runtime sees the same split: 31 elements on the main view
//     (menu bar, toolbar button captions, the pane names) and 136 inside the
//     Preferences dialog, because that dialog is real MFC. The project views
//     are drawn, not laid out as windows, so they are invisible to every
//     accessibility client.
//
// The consequence matters for any probe: standard dialogs (Preferences, any
// #32770) can be read element by element and acted on precisely — that is how
// the MIDI input port was enabled. Project views cannot; the only reader is
// pixels. So this module produces a probe plan naming the surface that carries
// each fact and accepts the observation back.
//
// Prefer the Event List view for notes. It is tabular text, so it survives
// reading far better than a piano-roll render where pitch must be inferred from
// grid position.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const CACHE_DIR = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'cakewalk-mcp');
const CACHE_FILE = join(CACHE_DIR, 'project-state.json');

// What each SONAR surface reveals. Keeping this in one place means the probe
// plan and the accepted-observation schema cannot drift apart.
export const SURFACES = {
  titlebar: {
    what: 'Active project name and dirty marker',
    how: 'The main window caption. cw_status already reports it from Win32 for builds that set it.',
  },
  trackView: {
    what: 'Track list: names, order, mute/solo/arm states, clip blocks',
    how: 'The Track view pane. Track headers run down the left; each shows an index, '
      + 'name, M/S/R buttons and a volume/pan readout on hover. Ask for the header column '
      + 'only — it is the highest signal-to-noise region.',
  },
  consoleView: {
    what: 'Every track/bus volume, pan, mute, solo, output assignment',
    how: 'The Console view (Alt+2 or the 控制台 tab). One strip per track: fader position, '
      + 'pan knob, M/S buttons, output dropdown. This is the only place fader values are '
      + 'readable as numbers.',
  },
  inspector: {
    what: 'Selected track detail: input/output, sends, ProChannel',
    how: 'The Inspector pane on the left of the Track view. Reflects the selected track only.',
  },
  eventList: {
    what: 'Notes and controllers as text rows (pitch, start, duration, velocity)',
    how: 'The Event List view (视图 > 事件查看器). This is the surface to read notes from — '
      + 'it is tabular text, so it survives OCR far better than a piano-roll render.',
  },
  pianoRoll: {
    what: 'Note positions as graphics',
    how: 'PRV. Use only when the Event List is unavailable; note pitch must be inferred from '
      + 'grid position, which is unreliable.',
  },
  transport: {
    what: 'Now-time, tempo, loop range, play state',
    how: 'The transport toolbar. Now-time is a text field in Bars|Beats, so it is directly legible.',
  },
};

/**
 * Operations that need the UI, written as recipes a computer-use agent can
 * follow. Each one is the result of actually doing it, including the parts that
 * failed — the failures are the expensive knowledge.
 */
export const OPERATION_RECIPES = {
  newProject: {
    goal: 'Get a project with tracks, so the MIDI transport has somewhere to land.',
    steps: [
      'Open the Quick Start panel (the caret beside the 工程 tab, bottom-left) or use 文件 > 新建.',
      'The 新建工程文件 dialog is JUCE: accessibility shows only its title and close button. '
        + 'Read the form from a screenshot and click by coordinate.',
      'Fields: 名称 (name), 位置 (location), 音频路径, 速度, 拍号, then a template list. '
        + 'Pick 16-Track or 4-Track — an empty template leaves nothing to arm.',
      'The 确定 button stays disabled while 位置 does not exist. Create the directory on disk '
        + 'first, or point 位置 at an existing folder; the dialog does not always re-validate '
        + 'after the directory appears, so re-touch a field to force it.',
    ],
    caution: 'This dialog is modal and blocks SONAR\'s UI thread. If computer-use starts timing '
      + 'out while it is open, recover with Win32: WM_COMMAND(2), then WM_COMMAND(1), then '
      + 'WM_CLOSE on the dialog hwnd. Do not keep retrying computer-use.',
  },
  armTrackForMidi: {
    goal: 'Make an incoming MIDI message actually reach a track.',
    steps: [
      'Enable the cable as an input: cw_enable_midi_port writes TTSSEQ.INI. Verify with '
        + 'cw_midi_status (sonarReceives).',
      'In SONAR, arm a MIDI track — the R button in its track header. Alternatively assign the '
        + 'input to ACT / MIDI learn so it drives the focused control instead of a track.',
      'Note the port is only read at startup or when Preferences > MIDI > 设备 is applied, so a '
        + 'change written by cw_enable_midi_port needs one of those to take effect.',
    ],
    caution: 'Without an armed destination the messages are still delivered and still valid; '
      + 'they simply have nowhere to go. A send returning rc=0 is not evidence of reception — '
      + 'cw_midi_status is.',
  },
  insertMidiTrack: {
    goal: 'Add a MIDI track to an existing project.',
    steps: [
      'Open the Track view first; the toolbar modules along the top switch what is shown.',
      'Insert a track from 插入 in the track area context menu, or 文件 > 新建 with a multi-track '
        + 'template to start with a full set.',
    ],
    caution: 'The command index lists 插入(I)->辅助轨道 and the per-track mixer actions '
      + '(0x8202 mute all, 0x8203 solo all, 0x8204 record-arm all) but posting them via '
      + 'WM_COMMAND does nothing — they are view-scoped. Reach them through the menu with '
      + 'AXExpand, or through the UI.',
  },
  importMidi: {
    goal: 'Get a .mid file into SONAR with its notes and mixer values intact.',
    steps: [
      'cw_run_command 0xE101 (文件 > 打开) — this opens a standard MFC dialog.',
      'Set the filename field with AXSetValue: it works on MFC dialogs, unlike the track strips. '
        + 'The element is the textfield titled 文件名(N).',
      'Click the 打开(O) button by index.',
      'If a document is already open, SONAR asks whether to save it — 是/否/取消. Answer before '
        + 'the new file loads.',
    ],
    caution: 'Opening a file whose NAME matches the one already loaded does nothing — SONAR treats '
      + 'it as already open and skips the reload. Verified: after rewriting song.mid with new mixer '
      + 'values and re-opening it, the strips still showed the old values; copying to '
      + 'song-mix-v2.mid and opening that worked immediately. When iterating on a generated file, '
      + 'write to a new filename (or close the document first) rather than overwriting in place.',
  },
  applyMix: {
    goal: 'Set track volume and pan so the values stick.',
    steps: [
      'Write CC7 (volume) and CC10 (pan) as the FIRST events of each track in a .mid file, then '
        + 'import it. CC10 is 0 hard left, 64 centre, 127 hard right.',
      'The track\'s notes, program change and CCs must all be on the SAME channel: SONAR routes a '
        + 'CC to the track carrying that channel, so a mismatch puts the mix on the wrong strip. '
        + 'cw_write_midi_file checks this and warns.',
      'Verify by reading the strips back: 音量 on Track N and 声像 on Track N.',
    ],
    caution: 'A live CC7/CC10 over the cable (cw_set_volume / cw_set_pan) does NOT move the strip '
      + 'unless the track is monitoring that channel (record-armed or ACT-bound), and arming cannot '
      + 'be set through automation. Measured: after sending a mix over the cable, the strips still '
      + 'read their imported values.',
  },
};
/**
 * Build the ordered probe plan for a question about project state.
 * `topic` narrows it; omit to get everything worth reading.
 */
export function probePlan(topic) {
  const key = normaliseTopic(topic);
  const order = {
    overview: ['titlebar', 'transport', 'trackView'],
    tracks: ['trackView', 'consoleView'],
    mixer: ['consoleView'],
    notes: ['eventList'],
    selection: ['inspector'],
    all: ['titlebar', 'transport', 'trackView', 'consoleView', 'inspector', 'eventList'],
  }[key] || ['titlebar', 'transport', 'trackView'];

  return {
    topic: key,
    caveat: key === 'notes' || key === 'all'
      ? 'Open the Event List view first (视图 > 事件查看器); a piano-roll render cannot be read reliably.'
      : undefined,
    surfaces: order.map((name) => ({ surface: name, ...SURFACES[name] })),
    // The steps an agent with computer-use should run, in order.
    steps: [
      'Focus SONAR (main window titled "Cakewalk Sonar"). Close modal panels first — '
        + 'cw_close_overlays does this, and an open panel hides the views behind it.',
      'Open the view the target surface needs (Track view is the default; Event List via '
        + '视图 > 事件查看器; Console via the 控制台 tab).',
      'Capture the region listed under each surface below and read it visually. Project views are '
        + 'drawn, not laid out as controls, so their content must come from the image.',
      'Report each value with its 1-based track index, matching the numbering the CakeScript tools used.',
    ],
    readable: {
      dialogs: 'Standard MFC dialogs (Preferences and any #32770 window) ARE readable element by '
        + 'element and can be clicked and toggled precisely — that is how MIDI ports get enabled.',
      views: 'Project views (track list, mixer, piano roll) are NOT readable through any '
        + 'accessibility API on this build — capture them as images.',
      juceDialogs: 'JUCE dialogs (Quick Start, 新建工程文件, the command palette) expose only their '
        + 'title and close button; everything else must be read from the image and clicked by '
        + 'coordinate. See cw_ui_recipe for the full picture and the recovery procedure.',
    },
    /*
     * Driving the views themselves. SONAR's own menu bar IS reachable through
     * accessibility even though WM_COMMAND is not — expand a top-level item with
     * AXExpand and every entry becomes a clickable element. That is how a view
     * gets opened (文件 > 新建, or a 视图 entry) when cw_run_command cannot.
     */
    openingViews: {
      how: 'Expand the menu item with AXExpand, then click the entry by index.',
      note: 'The top-level menus 文件/编辑/工具/帮助 each expose AXExpand. The 视图 menu appears '
        + 'in the command index but not always in the frame menu bar; when it is absent, open a '
        + 'view through 文件 or the toolbar modules instead.',
      keyboard: 'Not usable: synthetic key events do not reach SONAR, verified repeatedly.',
    },
    report: {
      tool: 'cw_report_state',
      hint: 'Send the reading back with cw_report_state so later calls reuse it instead of re-probing.',
    },
    operations: OPERATION_RECIPES,
  };
}

function normaliseTopic(topic) {
  const t = String(topic || 'overview').toLowerCase();
  if (['overview', 'tracks', 'mixer', 'notes', 'selection', 'all'].includes(t)) return t;
  if (/track|轨道/.test(t)) return 'tracks';
  if (/mix|fader|volume|pan|混音|推子/.test(t)) return 'mixer';
  if (/note|midi|音符/.test(t)) return 'notes';
  if (/select|inspector|选中/.test(t)) return 'selection';
  return 'overview';
}

// --- observation cache ------------------------------------------------------

function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return { observations: {} };
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) { return { observations: {} }; }
}

function writeCache(c) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), 'utf8');
    return true;
  } catch (_) { return false; }
}

/**
 * Accept an observation produced by a computer-use agent and cache it.
 * `state` is free-form; keep the shape close to what the CakeScript tools
 * returned so callers see one consistent schema:
 *   { tracks: [{ index, name, type, volume, pan, mute, solo, arm, clips }],
 *     notes:  [{ track, pitch, velocity, time, duration }],
 *     now, tempo, loop, project }
 */
export function reportState({ topic = 'overview', state, source = 'computer-use', note } = {}) {
  if (!state || typeof state !== 'object') {
    const e = new Error('state must be an object describing what was observed');
    e.code = 'BAD_OBSERVATION';
    throw e;
  }
  const c = readCache();
  const key = normaliseTopic(topic);
  const entry = {
    topic: key,
    state,
    source,
    note: note || null,
    observedAt: new Date().toISOString(),
  };
  c.observations[key] = entry;
  c.lastUpdated = entry.observedAt;
  const stored = writeCache(c);
  return { ok: true, stored, cacheFile: CACHE_FILE, entry };
}

/** Read back the most recent observation for a topic, if any. */
export function getState(topic) {
  const c = readCache();
  const key = normaliseTopic(topic);
  const entry = c.observations[key];
  if (!entry) {
    return {
      available: false,
      topic: key,
      reason: 'No observation cached. On this SONAR build project state can only be read with a '
        + 'computer-use runtime; call cw_probe_state to get the plan, then cw_report_state with the reading.',
      cacheFile: CACHE_FILE,
    };
  }
  return { available: true, stale: isStale(entry.observedAt), ...entry, cacheFile: CACHE_FILE };
}

/** Everything cached, for a quick look at what has been observed so far. */
export function listState() {
  const c = readCache();
  return {
    cacheFile: CACHE_FILE,
    lastUpdated: c.lastUpdated || null,
    topics: Object.keys(c.observations).map((k) => ({
      topic: k,
      observedAt: c.observations[k].observedAt,
      stale: isStale(c.observations[k].observedAt),
    })),
  };
}

function isStale(iso, maxMinutes = 30) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > maxMinutes * 60_000;
}
