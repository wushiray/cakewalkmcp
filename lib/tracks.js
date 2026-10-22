// lib/tracks.js — add tracks to the open project.
//
// Two mechanisms, and the split matters:
//
//   * Insertion is a menu command. 插入 > MIDI 轨 is 0x82A6, 音频轨 is 0x82A5,
//     stereo bus 0x8425, folder 0x84DB. These are document-scoped, so they only
//     respond when a project is open (see commands.js) — with no document the
//     menu bar does not even contain 插入.
//
//   * Verification is not. The insert commands change track count without
//     opening a window, so the window-diff test used by cw_verify_commands is
//     blind to them. The signal that works is the window TITLE: SONAR appends
//     a "*" to mark the project modified, so a successful insert on a clean
//     project flips `name.cwp` to `name.cwp*`. On an already-modified project
//     that signal is already spent, so track COUNT is the real check — and
//     track count is only visible through accessibility, i.e. through a
//     computer-use runtime (see track-ui.js).
//
// So this module posts the command and reads back what it can (title, plus a
// track count when a caller supplies one). It does not claim to confirm the
// insert itself.

import { call } from '../bridge/agent.js';
import { runCommand } from './menu.js';
import { documentState } from './track-ui.js';

/** Insert commands, measured against 32.10.0.021. */
export const INSERT_COMMANDS = {
  midiTrack: { cmdId: 0x82A6, hex: '0x82A6', name: '插入 > MIDI 轨', en: 'Insert > MIDI Track' },
  audioTrack: { cmdId: 0x82A5, hex: '0x82A5', name: '插入 > 音频轨', en: 'Insert > Audio Track' },
  stereoBus: { cmdId: 0x8425, hex: '0x8425', name: '插入 > 立体声总线', en: 'Insert > Stereo Bus' },
  multipleTracks: { cmdId: 0x85C9, hex: '0x85C9', name: '插入 > 多条音轨', en: 'Insert > Multiple Tracks' },
  folder: { cmdId: 0x84DB, hex: '0x84DB', name: '插入 > 文件夹', en: 'Insert > Folder' },
  auxTrack: { cmdId: 0xA78E, hex: '0xA78E', name: '插入 > 辅助轨道', en: 'Insert > Aux Track' },
  trackTemplate: { cmdId: 0x8536, hex: '0x8536', name: '插入 > 音轨模板', en: 'Insert > Track Template' },
};

const KIND_ALIASES = {
  midi: 'midiTrack', instrument: 'midiTrack', synth: 'midiTrack',
  audio: 'audioTrack', bus: 'stereoBus', folder: 'folder', aux: 'auxTrack',
};

/**
 * Add one track. `kind` is midi | audio | bus | folder | aux (aliases accepted).
 *
 * Returns what was posted and what the title did, and is explicit that the
 * insert itself is unconfirmed without a track count from the caller.
 */
export async function addTrack(kind = 'midi', { name } = {}) {
  const doc = await documentState();
  if (!doc.projectOpen) {
    const e = new Error(
      'No project is open, so there is no 插入 menu and nothing to add a track to. '
      + 'Open or create a project first (cw_run_command 0x80B3 = 文件 > 新建).'
    );
    e.code = 'NO_DOCUMENT';
    throw e;
  }

  const key = KIND_ALIASES[String(kind).toLowerCase()] || kind;
  const cmd = INSERT_COMMANDS[key];
  if (!cmd) {
    const e = new Error(
      `Unknown track kind '${kind}'. Use one of: ${Object.keys(INSERT_COMMANDS).join(', ')} `
      + `(or the aliases ${Object.keys(KIND_ALIASES).join(', ')}).`
    );
    e.code = 'BAD_KIND';
    throw e;
  }

  const beforeTitle = doc.title;
  const result = await runCommand(cmd.cmdId);
  await new Promise((r) => setTimeout(r, 900));

  let afterTitle = beforeTitle;
  try {
    const s = await call('status');
    afterTitle = s?.sonar?.title || beforeTitle;
  } catch (_) { /* keep the old title */ }

  // Two title shapes exist: "name.cwp* - Cakewalk Sonar" (current) and the older
  // "Cakewalk Sonar - [name.cwp*]". Matching only the bracketed one reported
  // modificationDetected:false on a project that had just been modified.
  const isModifiedTitle = (t) => {
    if (!t) return false;
    const title = t.replace(/\s*\[(?:未激活|已激活|not\s+activated|activated)\]\s*$/i, '');
    return /\*\s*-\s*Cakewalk Sonar\s*$/i.test(title) || /\*\]\s*$/.test(title) || /\]\*\s*$/.test(title);
  };
  const becameModified = !isModifiedTitle(beforeTitle) && isModifiedTitle(afterTitle);

  return {
    ok: true,
    inserted: cmd.name,
    cmdId: cmd.cmdId,
    posted: result.posted,
    project: doc.project,
    titleBefore: beforeTitle,
    titleAfter: afterTitle,
    // Only meaningful on a previously-clean project.
    modificationDetected: becameModified,
    confirmed: becameModified ? 'title-now-modified' : 'unconfirmed',
    note: becameModified
      ? 'The project title gained "*", so the insert landed.'
      : 'The project was already modified, so the title cannot confirm this insert. Track count is '
        + 'the real check, and it needs a computer-use runtime — see cw_track_controls.',
    trackName: name || null,
    next: name
      ? `Rename it after inserting: the track name element is "音轨 <N> on Track <N>", and writing `
        + 'through accessibility is a no-op — use the rename dialog or the MIDI path.'
      : undefined,
  };
}

/**
 * The song skeleton: the tracks a simple arrangement needs, in order.
 * Roles use the instrument families found by lib/plugins.js.
 */
export const SONG_SKELETON = [
  { role: 'drums', kind: 'midi', suggest: ['EZdrummer 3', 'SSDSampler5', 'Studio Instruments Drum Kit'] },
  { role: 'bass', kind: 'midi', suggest: ['EZbass', 'Ample Bass P Lite', 'Bass'] },
  { role: 'keys', kind: 'midi', suggest: ['EZkeys 2', 'Electric Piano'] },
  { role: 'guitar', kind: 'midi', suggest: ['Ample Guitar SC', 'Ample Guitar M Lite'] },
  { role: 'strings', kind: 'midi', suggest: ['BBC Symphony Orchestra', 'String Pad'] },
  { role: 'synth', kind: 'midi', suggest: ['Massive X', 'Kontakt 7', 'Vista Synth'] },
];

/**
 * Add every track in the skeleton. Sequential on purpose: the insert command is
 * a UI action and firing them concurrently is not something SONAR's menu
 * handler is built for.
 *
 * `budgetMs` exists because this was measured hanging. With no `roles`, the call
 * adds all six — and each insert is a menu post plus a verification wait, so a
 * bare `cw_add_song_tracks` took over 60 s on a loaded machine. That is past the
 * point where a client gives up, so the default path looked like a dead tool
 * rather than a slow one. It now stops at the budget and says which roles it did
 * not reach, on the same reasoning as cw_verify_commands: a bounded partial is
 * useful, a hang is not.
 */
export async function addSongSkeleton({ roles, budgetMs = 25_000 } = {}) {
  const wanted = roles && roles.length
    ? SONG_SKELETON.filter((s) => roles.includes(s.role))
    : SONG_SKELETON;
  const started = Date.now();
  const added = [];
  const skipped = [];

  for (const spec of wanted) {
    // Check before starting, so the overrun is a skip rather than a half-done
    // insert that leaves the project in a state the caller cannot see.
    if (Date.now() - started > budgetMs) {
      skipped.push(spec.role);
      continue;
    }
    try {
      const r = await addTrack(spec.kind);
      added.push({ role: spec.role, ...r, instrumentSuggestions: spec.suggest });
    } catch (e) {
      added.push({ role: spec.role, ok: false, error: e.message, code: e.code });
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  const elapsed = Date.now() - started;
  return {
    requested: wanted.length,
    attempted: added.length,
    added: added.filter((a) => a.ok).length,
    tracks: added,
    notAttempted: skipped,
    partial: skipped.length > 0,
    elapsedMs: elapsed,
    partialNote: skipped.length
      ? `Ran out of the ${budgetMs}ms budget after ${added.length} of ${wanted.length} tracks. `
        + `Not attempted: ${skipped.join(', ')}. Call again with those roles, or raise budgetMs. `
        + 'Budget accordingly: one insert was MEASURED at ~19s on this machine (menu post + '
        + 'verification wait), so the full six-track skeleton needs ~2 minutes, not the ~20s an '
        + 'earlier version of this note claimed. The default budget of 10s therefore covers no '
        + 'single track on a slow machine — pass roles and a budget together when you need '
        + 'several.'
      : undefined,
    caution:
      'Each insert adds a track with SONAR\'s default instrument. Loading a specific plugin into a '
      + 'track is a separate step that this adapter does not drive — do it in the UI, or route MIDI '
      + 'to an existing synth with cw_midi_*.',
  };
}
