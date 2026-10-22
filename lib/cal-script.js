// lib/cal-script.js — edit notes through CAL, SONAR's legacy macro language.
//
// WHY THIS MODULE EXISTS
//
// CakeScript (Lua) is the broad API, and on a free licence it is gated: posting
// 处理 > 运行 CakeScript 程序 (0xA78D) opens the Membership paywall. The whole
// adapter was built around that gate — accessibility writes into edit dialogs,
// plus the realtime MIDI cable — which covers transforming existing notes but
// not creating, deleting or reading them.
//
// CAL is the way around that, and it needs no licence. Posting
// 处理 > 运行 CAL 程序 (0x806A) opens an ordinary file-open dialog listing
// *.CAL, and the interpreter behind it reads and writes note data directly.
// Measured on 2026-10-15, all four operations verified end to end against an
// exported .mid parsed back with cw_read_midi_file:
//
//   modify  (= Note.Vel 64)                     8 notes, velocity 100 -> 64
//   create  (insert t ch NOTE (+ k 12) v d) x3  8 notes -> 32, each new pitch
//                                               exactly source+12/+16/+19
//   delete  (if (>= Note.Key 80) (delete))      32 notes -> 16, no residue
//   read    statistics written into TrackName   Q:n16,lo60,hi79,... exact
//
// The gate the project documented is real, but it does not cover note editing.
//
// WHAT CAL IS
//
// Every claim below is evidenced by the 37 scripts shipped in the CAL folder;
// where a fact is not observable there it is marked as such rather than
// guessed. The language itself has no published reference on this machine.
//
//   - A script is a sequence of parenthesised expressions. The three-slot
//     "prolog / body / epilog" split in the shipped scripts is a CONVENTION,
//     not grammar: the body slot is re-evaluated once per selected event, and
//     a script may equally be a single (do ...) or a single bare (if ...).
//     `(forEachEvent expr)` is the explicit alternative, which does nothing
//     unless called. `NIL` in the body slot means "no per-event work".
//   - Variables are declared inline: (int name init), (dword ...), (word ...),
//     (string ...). A prolog variable persists across the per-event walk; that
//     is the only cross-event state mechanism, and the shipped scripts use it
//     to carry the previous event's fields forward.
//   - Fields: Event.Kind (NOTE, CONTROL, WHEEL, CHANAFT observed; KEYAFT and
//     PATCH addressable via the filter API), Event.Time, Event.Chan, Note.Key,
//     Note.Vel, Note.Dur, Control.Num, Control.Val, Wheel.Val, ChanAft.Val.
//     Event.Kind and Event.Chan are read-only in every shipped usage.
//   - Arithmetic is INTEGER: `/` truncates. Compound assignment (++ -- += -= *=
//     /=) returns the new value, so it can be nested in an expression.
//   - Output is `message` (status line) or `pause` (modal), and nothing else.
//     There is no file write in any of the 37 scripts — so a large result
//     cannot come back as text. See QUERY below for the channel that works.
//
// THE TWO TRAPS, BOTH RECORDED IN THE SHIPPED SCRIPTS
//
//   1. `insert` resets the in-flight event's fields. HARMONYZ.CAL says so
//      outright ("insertion reset Event.Time during the building of the same
//      chord"). Every template here copies the source fields into prolog
//      variables BEFORE its first insert. Measured consequence of getting this
//      wrong: the second and third inserted notes land at the wrong time.
//   2. Durations are 16-bit and wrap at 65535 (STRUM-IT.CAL). Subtracting from
//      a short duration can turn it into a huge one.
//
// READING NOTES BACK (the weakest link, stated plainly)
//
// CAL cannot write a file, so a query cannot return a note list. What works is
// encoding a compact summary into a property the adapter can already read:
// TrackName. That is verified, and it is a WRITE to project data, so
// `queryNotes` requires an explicit opt-in and is never the default. Full note
// data is better obtained by exporting a .mid and parsing it (cw_read_midi_file)
// — no side effect, already verified.
//
// EXECUTION MODEL
//
// Like every dialog in this adapter, this module cannot click. It writes the
// script file, posts the command, and returns the exact steps an accessibility
// runtime must perform on the file dialog — the same contract as
// quantizePlan/openDialogFor. The field indices below were measured on the
// dialog 0x806A actually opens.

import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { calFolder } from './sonar.js';
import { documentState } from './track-ui.js';
import { runCommand } from './menu.js';

/** The one menu command this module drives. */
export const CAL_COMMAND = {
  key: 'runCal',
  cmdId: 0x806A,
  hex: '0x806A',
  name: '处理 > 运行 CAL 程序',
  en: 'Process > Run CAL Program',
  precondition: 'a project open; a selection, for a script that acts per event',
  affects: 'runs a CAL macro over the selected events',
  outcome: 'opens a #32770 file dialog listing *.CAL, then executes the chosen program',
  risk: 'medium',
  riskWhy: 'the script decides what it does; a CAL run is covered by undo (the shipped '
    + 'RANDTIME.CAL and STRUM-IT.CAL both tell the user to recover with Edit > Undo), which '
    + 'is the only backstop — there is no preview and no confirmation inside CAL itself.',
  verified: 'MEASURED 2026-10-15. Posting 0x806A opens a standard MFC file dialog titled 打开, '
    + 'starting in the CAL folder, with file type CAL. NOT the membership paywall — that is what '
    + '0xA78D (CakeScript) opens. Scripts were run through this dialog and their effects read '
    + 'back out of an exported .mid.',
};

/**
 * The file dialog that 0x806A opens, measured.
 *
 * Same class of dialog as the one 项目 > 打开 uses, so the same write technique
 * applies — and the same trap: the filename textfield and the readonly label
 * that carries it share a name, and writing to the wrong one is accepted and
 * ignored.
 */
export const RUN_CAL_DIALOG = {
  title: '打开',
  openedBy: '0x806A (处理 > 运行 CAL 程序) with a project open',
  windowClass: '#32770',
  startsIn: 'the CAL folder, read from calFolder()',
  fileFilter: 'CAL',
  fields: {
    filename: {
      label: '文件名(N):', kind: 'textfield', element: 33,
      meaning: 'the script to run',
      values: 'a bare filename (the dialog is already in the CAL folder) or a full path',
      warning: 'THREE controls can carry this label — a combobox, a textfield and a readonly '
        + 'text row — and writing to any but the textfield is accepted and ignored. Worse, the '
        + 'textfield\'s index MOVES: measured at 33 on one observation and 32 on the next, '
        + 'because the shell adds or drops a control depending on whether the file list has '
        + 'finished populating. Do not trust the number. Find the target by label AND kind AND '
        + 'writability: take the elements whose title is 文件名(N): and whose actions include a '
        + 'set-value action, and write that one.',
    },
    open: { label: '打开(O)', kind: 'button', element: 26 },
    cancel: { label: '取消', kind: 'button', element: 25 },
  },
  note: 'Element indices are NOT stable here, which is a stronger statement than the usual '
    + '"re-read before writing". Observed directly: the filename textfield was element 33 in one '
    + 'observation and 32 in the next, on the same dialog, because a shell control appears or '
    + 'disappears while the folder list loads. The button at 26 held steady across both. Resolve '
    + 'the textfield by property, not by index.',
  measured: 'MEASURED 2026-10-15: set the 文件名 textfield and pressed 26; the script ran. Then '
    + 'again through cw_cal_run, where the textfield had moved to 32 — which is how the '
    + 'instability above was found.',
};

/**
 * Every CAL program this module knows how to generate.
 *
 * The metadata shape mirrors EDIT_COMMANDS in edit.js on purpose — the same
 * invariant tests sweep it — with one addition: `op` names the generator below
 * that produces the source.
 */
export const CAL_PROGRAMS = {
  setVelocity: {
    op: 'setVelocity',
    name: '把力度设为固定值',
    en: 'Set velocity to a fixed value',
    affects: 'Note.Vel on every selected note',
    needsSelection: true,
    sideEffect: 'none',
    verified: 'MEASURED 2026-10-15. 8 notes, velocity 100 -> 64 across the board, read back '
      + 'from an export.',
  },
  scaleVelocity: {
    op: 'scaleVelocity',
    name: '按百分比缩放力度',
    en: 'Scale velocity by a percentage',
    affects: 'Note.Vel, scaled and clamped to 1..127',
    needsSelection: true,
    sideEffect: 'none',
    verified: 'MEASURED 2026-10-15 by the equivalent dialog path (处理 > 力度); the CAL form '
      + 'uses the same arithmetic as the shipped "Scale Velocity.cal".',
  },
  addNotes: {
    op: 'addNotes',
    name: '叠加音符',
    en: 'Add notes at fixed intervals above each source note',
    affects: 'inserts one note per interval, per selected note',
    needsSelection: true,
    sideEffect: 'adds note events; covered by undo',
    verified: 'MEASURED 2026-10-15. 8 notes -> 32 with intervals 12/16/19; every inserted pitch '
      + 'was exactly source+interval and every inserted tick matched its source tick.',
  },
  deleteNotes: {
    op: 'deleteNotes',
    name: '按条件删除音符',
    en: 'Delete notes matching a predicate',
    affects: 'removes matching note events',
    needsSelection: true,
    sideEffect: 'removes note events; covered by undo',
    verified: 'MEASURED 2026-10-15. Predicate Note.Key >= 80 deleted exactly the 16 matching '
      + 'notes out of 32, with none left above the threshold.',
  },
  transpose: {
    op: 'transpose',
    name: '移调（CAL 版）',
    en: 'Transpose notes by a semitone interval',
    affects: 'Note.Key, shifted and clamped to 0..127',
    needsSelection: true,
    sideEffect: 'none',
    verified: 'MEASURED 2026-10-15 for the equivalent dialog path (处理 > 移调, +3 semitones '
      + 'verified from an export). The CAL arithmetic itself was verified through the same '
      + 'Note.Key writes used by addNotes.',
  },
  setDuration: {
    op: 'setDuration',
    name: '按百分比缩放时值',
    en: 'Scale note durations by a percentage',
    affects: 'Note.Dur, clamped below the 16-bit ceiling',
    needsSelection: true,
    sideEffect: 'none',
    verified: 'unverified — the arithmetic is the same shape as scaleVelocity, but no CAL run '
      + 'has been measured for Note.Dur specifically.',
  },
  queryNotes: {
    op: 'queryNotes',
    name: '查询音符统计',
    en: 'Summarise the selection into the track name',
    affects: 'writes a summary string into the track name',
    needsSelection: true,
    sideEffect: 'RENAMES the track — this is how the result gets back to the caller, since CAL '
      + 'has no file-write channel. Opt in with allowRename.',
    verified: 'MEASURED 2026-10-15. 16 notes reported as '
      + '"Q:n16,lo60,hi79,v64-64,d6400,t0-3360", matching the project exactly.',
  },
  dumpNotes: {
    op: 'dumpNotes',
    name: '逐音符输出到消息栏',
    en: 'Print each note on the CAL message line',
    affects: 'no change to note data',
    needsSelection: true,
    sideEffect: 'a modal pause dialog needs dismissing',
    verified: 'PARTIALLY MEASURED 2026-10-15, with a negative result worth recording: a string '
      + 'built up across the per-event walk did NOT accumulate, so the printed line held the '
      + 'count and none of the data. Use queryNotes for machine-readable output; this one is '
      + 'for a human looking at the screen.',
  },
  renameTrack: {
    op: 'renameTrack',
    name: '重命名轨道',
    en: 'Rename a track',
    affects: 'the name of one track, addressed by index',
    needsSelection: false,
    sideEffect: 'renames a track — the only track property the edit dialogs cannot touch at all',
    verified: 'MEASURED 2026-10-15 end to end. (TrackName "MCP-VERIFY" 2) ran through 0x806A and '
      + 'the exported .mid came back with that track named MCP-VERIFY. Note the index offset: CAL '
      + 'counts tracks from 0 among the project tracks, while an exported .mid places the conductor '
      + 'track first, so CAL track N appears as export track N+1. This CORRECTS the project\'s '
      + 'earlier claim that track rename needs CakeScript — it does not.',
  },
  setTrackMute: {
    op: 'setTrackMute',
    name: '静音/取消静音轨道',
    en: 'Mute or un-mute a track',
    affects: 'one track\'s mute state, addressed by index',
    needsSelection: false,
    sideEffect: 'changes a track\'s mute flag',
    verified: 'Syntax PROVEN from the shipped scripts and SEMANTICS pinned by a shipped comment: '
      + '"Split Channel to Tracks.cal":40 reads "; Un-mute the track" directly above '
      + '(TrackActive TRUE nTrk), so TRUE = audible and FALSE = muted. The FILE STRUCTURE is '
      + 'proven by the renameTrack measurement (same prolog + NIL + epilog shape). What is NOT '
      + 'measured: a run of this specific program, and any read-back — a mute flag does not '
      + 'appear in an exported .mid, so verifying it needs the accessibility tree, which was '
      + 'not available in a stable state during this session. Treat the effect as probable but '
      + 'unconfirmed. No solo or record-arm builtin exists — grepping the shipped set for '
      + 'TrackSolo / TrackArm returns zero, which is a clean negative.',
  },
  setTrackRouting: {
    op: 'setTrackRouting',
    name: '设置轨道通道/端口',
    en: 'Set a track\'s MIDI channel and/or port',
    affects: 'one track\'s channel and port, addressed by index',
    needsSelection: false,
    sideEffect: 'changes track routing',
    verified: 'Syntax PROVEN from the shipped scripts: (TrackChannel <chan> <idx>) at '
      + '"Split Channel to Tracks.cal":39 and (TrackPort <port> <idx>) at '
      + '"Split Note to Tracks.cal":111. File structure proven by the renameTrack measurement '
      + '(identical shape). A run of this specific program is NOT measured. There is no '
      + 'input/output builtin in CAL — those are UI-only or project-file properties.',
  },
};

/** Clamp helper shared by the templates, so the generated bounds match the docs. */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * CAL source is a flat text file. These generators return it, so a caller gets
 * a script whose parameters are baked in rather than prompted for — the
 * shipped scripts use (getInt ...) for interactivity, but a prompt is a modal
 * dialog that would block an unattended run, so nothing here emits one.
 */
function header(title, notes) {
  const lines = [`;; ${title}`, ';;', ';; Generated by cakewalk-mcp. Edit freely — this file is'];
  lines.push(';; self-contained apart from the (include), which needs need20.cal in the same folder.');
  if (notes.length) { lines.push(';;'); for (const n of notes) lines.push(`;; ${n}`); }
  return lines.join('\n');
}

/**
 * Copy the per-event fields into prolog variables.
 *
 * Every generator that INSERTS must start its body with this. `insert` resets
 * the in-flight event (HARMONYZ.CAL), so a field read after the first insert is
 * not the field that was there before it. Emitting these assignments is the
 * whole reason the generators exist rather than callers writing CAL by hand.
 */
const CACHE_FIELDS = [
  '    (= t Event.Time)',
  '    (= ch Event.Chan)',
  '    (= k Note.Key)',
  '    (= v Note.Vel)',
  '    (= d Note.Dur)',
].join('\n');

const CACHE_DECL = [
  '  (dword t 0)',
  '  (int ch 1)',
  '  (int k 0)',
  '  (int v 100)',
  '  (dword d 240)',
].join('\n');

/** (a) Set every selected note's velocity to one value. */
export function setVelocitySource({ velocity = 64 } = {}) {
  const vel = clamp(Math.round(velocity), 1, 127);
  return `${header(`Set every note velocity to ${vel}`, [
    'Simplest possible edit, and the one used to establish that CAL runs at all.',
  ])}
(do
  (include "need20.cal")
  (int target ${vel})
  (int n 0)
)
(if (== Event.Kind NOTE)
  (do
    (= Note.Vel target)
    (++ n)
  )
  NIL
)
(pause "MCP setVelocity: " n " notes set to ${vel}.")
`;
}

/** (b) Scale velocities by a percentage. */
export function scaleVelocitySource({ percent = 50 } = {}) {
  const pct = clamp(Math.round(percent), 1, 1000);
  return `${header(`Scale every note velocity to ${pct}%`, [
    'Clamped to 1..127 after scaling, so a high percentage cannot push a velocity out of range.',
    'Integer arithmetic is deliberate — CAL division truncates, and the shipped',
    '"Scale Velocity.cal" multiplies then divides by 100 for the same reason.',
    'The multiply/divide runs on a single dword temporary declared once in the',
    'prolog and echoed back to Note.Vel once, after clamping, so no intermediate',
    'value can wrap the velocity field.',
  ])}
(do
  (include "need20.cal")
  (int pct ${pct})
  (int n 0)
  (dword v 0)
)
(if (== Event.Kind NOTE)
  (do
    (= v Note.Vel)
    (*= v pct)
    (/= v 100)
    (if (< v 1) (= v 1) NIL)
    (if (> v 127) (= v 127) NIL)
    (= Note.Vel v)
    (++ n)
  )
  NIL
)
(pause "MCP scaleVelocity: " n " notes scaled to ${pct}%.")
`;
}

/**
 * (c) Add notes at fixed semitone intervals above each source note.
 *
 * The cache block is not optional here — see CACHE_FIELDS.
 */
export function addNotesSource({ intervals = [12], velocity = null, channel = null } = {}) {
  function makeRangeError(message) {
    const e = new RangeError(message);
    e.code = 'BAD_INTERVAL';
    return e;
  }
  const raw = Array.isArray(intervals) ? intervals : [intervals];
  const list = [];
  for (const item of raw) {
    const num = Number(item);
    if (!Number.isFinite(num) || !Number.isInteger(num)) {
      throw makeRangeError(
        `addNotes intervals must be finite whole semitone offsets (got ${String(item)}).`,
      );
    }
    if (num < -127 || num > 127) {
      throw makeRangeError(`addNotes interval ${num} is outside -127..127 semitones.`);
    }
    if (num === 0) continue;
    list.push(num);
  }
  if (!list.length) {
    const e = new Error('addNotes needs at least one non-zero interval in semitones.');
    e.code = 'NO_INTERVALS';
    throw e;
  }
  const lines = list.map((iv) => {
    const key = iv >= 0 ? `(+ k ${iv})` : `(- k ${-iv})`;
    const vel = velocity === null ? 'v' : `${clamp(Math.round(velocity), 1, 127)}`;
    const ch = channel === null ? 'ch' : `${clamp(Math.round(channel), 1, 16)}`;
    return `    (do
      (= p ${key})
      (if (< p 0) (= p 0) NIL)
      (if (> p 127) (= p 127) NIL)
      (insert t ${ch} NOTE p ${vel} d)
    )`;
  }).join('\n');

  return `${header(`Add notes at intervals ${list.join(', ')} above each note`, [
    'The cache block above the inserts is load-bearing: `insert` resets the in-flight',
    'event, so fields read after the first insert are not the fields that were there',
    'before it (recorded in the shipped HARMONYZ.CAL, and visible as misplaced notes',
    'when it is left out).',
    'Each target pitch is assigned into the single prolog-declared int and',
    'clamped to 0..127 before the insert, so no fixed key falls outside the',
    'valid pitch range and the interval loop never redeclares it.',
    `Intervals: ${list.join(', ')} semitones.`,
  ])}
(do
  (include "need20.cal")
  (int n 0)
(int p 0)
${CACHE_DECL}
)
(if (== Event.Kind NOTE)
  (do
${CACHE_FIELDS}
${lines}
    (++ n)
  )
  NIL
)
(pause "MCP addNotes: added ${list.length} note(s) to each of " n " source notes.")
`;
}

/** (d) Delete notes matching a key range. */
export function deleteNotesSource({ minKey, maxKey } = {}) {
  // The old defaults were 0..127 — every note. A caller that simply forgot the
  // bounds got a silent "delete everything" plan. Make the bounds mandatory.
  if (minKey === undefined || maxKey === undefined) {
    const e = new Error('deleteNotes needs minKey and maxKey; without them the range is 0..127, '
      + 'which deletes every note in the selection.');
    e.code = 'NEED_BOUNDS';
    throw e;
  }
  const lo = clamp(Math.round(minKey), 0, 127);
  const hi = clamp(Math.round(maxKey), 0, 127);
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  return `${header(`Delete notes with key between ${a} and ${b}`, [
    '(delete) takes no arguments: it removes the event currently being visited.',
    'The shipped "Thin *" scripts delete in place with no index bookkeeping, and the',
    'CAL-to-Lua translator implements deletion as a filter rather than a renumbering,',
    'so the walk stays stable while events are removed.',
    `Inclusive range: ${a}..${b}.`,
  ])}
(do
  (include "need20.cal")
  (int lo ${a})
  (int hi ${b})
  (int nDel 0)
)
(if (&& (== Event.Kind NOTE) (>= Note.Key lo) (<= Note.Key hi))
  (do
    (delete)
    (++ nDel)
  )
  NIL
)
(pause "MCP deleteNotes: removed " nDel " note(s) in key range ${a}..${b}.")
`;
}

/** (e) Transpose by semitones, clamped to the MIDI range. */
export function transposeSource({ semitones = 0 } = {}) {
  const iv = Math.round(Number(semitones) || 0);
  const op = iv >= 0 ? `(+ Note.Key ${iv})` : `(- Note.Key ${-iv})`;
  return `${header(`Transpose every note by ${iv} semitone(s)`, [
    'Signed: a negative interval transposes down.',
    'Clamped to 0..127 — CAL writes the field directly, so an out-of-range key',
    'would be stored as-is rather than refused.',
  ])}
(do
  (include "need20.cal")
  (int n 0)
)
(if (== Event.Kind NOTE)
  (do
    (= Note.Key ${op})
    (if (< Note.Key 0) (= Note.Key 0) NIL)
    (if (> Note.Key 127) (= Note.Key 127) NIL)
    (++ n)
  )
  NIL
)
(pause "MCP transpose: " n " notes moved by ${iv} semitone(s).")
`;
}

/** (f) Scale durations, staying under the 16-bit ceiling. */
export function setDurationSource({ percent = 50 } = {}) {
  const pct = clamp(Math.round(percent), 1, 1000);
  return `${header(`Scale every note duration to ${pct}%`, [
    'Durations are 16-bit and wrap at 65535 (recorded in the shipped STRUM-IT.CAL),',
    'so the result is clamped rather than allowed to overflow into a huge value.',
    'The multiply/divide runs on a single dword temporary declared once in the',
    'prolog and echoed back to Note.Dur once, after clamping, so 40000 at 200%',
    'clamps to 65535 instead of wrapping.',
  ])}
(do
  (include "need20.cal")
  (int pct ${pct})
  (int n 0)
  (dword d 0)
)
(if (== Event.Kind NOTE)
  (do
    (= d Note.Dur)
    (*= d pct)
    (/= d 100)
    (if (< d 1) (= d 1) NIL)
    (if (> d 65535) (= d 65535) NIL)
    (= Note.Dur d)
    (++ n)
  )
  NIL
)
(pause "MCP setDuration: " n " note durations scaled to ${pct}%.")
`;
}

/**
 * (g) Summarise the selection into the track name.
 *
 * The result has to go somewhere the adapter can read, and CAL has no file
 * write. TrackName is a real property, and it is already readable from an
 * export — so the summary is encoded there. That is a modification to project
 * data, which is why this generator is the only one the tool refuses to run
 * without an explicit opt-in.
 *
 * Format: Q:n<count>,lo<min>,hi<max>,v<minVel>-<maxVel>,d<sumDur>,t<firstTick>-<lastTick>
 * Fixed key order and comma separators, so a parser does not depend on spacing
 * (CAL's format inserts a space before each substituted value).
 */
export function queryNotesSource({ trackIndex = 0 } = {}) {
  // 0..255 like every other generator and like the public schema. This one was
  // clamped to 127, so trackIndex 200 silently renamed track 127 instead — an
  // edit aimed at the wrong track, which is the worst kind of quiet failure.
  const trk = clamp(Math.round(trackIndex), 0, 255);
  return `${header('Summarise the selected notes into the track name', [
    'WHY A TRACK NAME: CAL cannot write a file, and its only text output (message /',
    'pause) did not carry a string accumulated across the per-event walk — measured,',
    'the count arrived and the data did not. A track name is a property the adapter',
    'can read back from an export, so the summary is encoded there instead.',
    'This MODIFIES the project (the rename). Undo covers it.',
    `Format: Q:n<count>,lo<min>,hi<max>,v<minVel>-<maxVel>,d<sumDur>,t<first>-<last>`,
    `Writes to track index ${trk}.`,
  ])}
(do
  (include "need20.cal")
  (int n 0)
  (int lo 127)
  (int hi 0)
  (int vmin 127)
  (int vmax 0)
  (dword dsum 0)
  (int first -1)
  (int last -1)
)
(if (== Event.Kind NOTE)
  (do
    (if (== first -1) (= first Event.Time) NIL)
    (= last Event.Time)
    (if (< Note.Key lo) (= lo Note.Key) NIL)
    (if (> Note.Key hi) (= hi Note.Key) NIL)
    (if (< Note.Vel vmin) (= vmin Note.Vel) NIL)
    (if (> Note.Vel vmax) (= vmax Note.Vel) NIL)
    (+= dsum Note.Dur)
    (++ n)
  )
  NIL
)
(TrackName (format "Q:n" n ",lo" lo ",hi" hi ",v" vmin "-" vmax ",d" dsum ",t" first "-" last) ${trk})
(pause "MCP queryNotes: reported " n " notes.")
`;
}

/** (h) Print each note on the message line, for a human watching the screen. */
export function dumpNotesSource() {
  return `${header('Print every note on the CAL message line', [
    'MEASURED CAVEAT: a string accumulated across the per-event walk does not survive',
    'it, so this cannot return a note list to a caller — the shipped behaviour prints',
    'the count and loses the data. Kept because it is useful to a human at the screen,',
    'and marked so nobody mistakes it for the machine-readable path (use queryNotes).',
  ])}
(do
  (include "need20.cal")
  (int n 0)
)
(if (== Event.Kind NOTE)
  (do
    (++ n)
    (message "NOTE idx " (index) " time " Event.Time " ch " Event.Chan
             " key " Note.Key " vel " Note.Vel " dur " Note.Dur)
  )
  NIL
)
(pause "MCP dumpNotes: " n " note(s) printed above.")
`;
}

/*
 * TRACK PROGRAMS
 *
 * These are the track-level builtins CAL actually has. They matter because the
 * project's own README listed track rename as reachable only through
 * CakeScript — which is wrong, and this is the correction. Track rename was
 * measured end to end on 2026-10-15: `(TrackName "MCP-RT1" 0)` ran, and the
 * exported .mid came back with track 0 named `MCP-RT1`.
 *
 * CAL has EXACTLY FIVE Track* builtins, confirmed by grepping every shipped
 * script for Track*:
 *
 *   (TrackName   "string" idx)      rename          Split Note to Tracks.cal:95
 *   (TrackChannel chan idx)         MIDI channel    Split Channel to Tracks.cal:39
 *   (TrackPort    port idx)         port            Split Note to Tracks.cal:111
 *   (TrackActive  TRUE|FALSE idx)   mute on/off     Split Channel to Tracks.cal:41
 *   (TrackSelect  0|1 idx)          selection       Split Note to Tracks.cal:57
 *
 * A grep for TrackMute / TrackSolo / TrackArm / TrackVolume / TrackPan /
 * TrackPatch / TrackBank / TrackOutput / TrackInput returns ZERO hits in the
 * shipped set — those are clean negatives, not oversights.
 *
 * `TrackActive` is the mute, and the shipped comment says so: the line
 * `; Un-mute the track` sits directly above `(TrackActive TRUE nTrk)`. So
 * FALSE mutes.
 *
 * Track indices are 0-based and CAL documents the range as 0..255
 * ("Split Note to Tracks.cal" carries the note `-- nSrcTrk ; CAL uses 0..255`).
 *
 * THE STRUCTURAL RULE, WHICH COST TWO FAILED RUNS TO FIND
 *
 * A top-level expression in a CAL file is not "just a statement" — it is the
 * per-event BODY slot. Putting a track builtin there fails with
 * `CAL Error 016: 无效的事件信息或主体表达式` naming the builtin.
 *
 * So the working shape is three slots:
 *
 *   (do ... )        <- prolog: declarations
 *   NIL              <- body: the event walk, empty here
 *   (TrackName ...)  <- epilog: track operations run ONCE, at top level
 *   (pause ... )     <- epilog: report
 *
 * The two ways to get this wrong, both measured:
 *   - bare (TrackName ...) with an event body present  -> Error 016
 *   - a single (do ...) wrapping the prolog AND the track call -> Error 016,
 *     because inside a (do) the call is no longer in the epilog slot
 *
 * This is why the generators below emit the `NIL` body explicitly rather than
 * folding everything into one (do).
 */

/** (i) Rename a track by index. */
export function renameTrackSource({ trackIndex = 0, name = 'Renamed' } = {}) {
  const trk = clamp(Math.round(trackIndex), 0, 255);
  // CAL string literals are double-quoted; a quote or backslash inside would end
  // the literal, so they are stripped rather than escaped — CAL has no escape
  // syntax in any shipped script, and emitting one would be a guess.
  const safe = String(name).replace(/["\\\r\n]/g, '').slice(0, 100);
  return `${header(`Rename track ${trk} to "${safe}"`, [
    'CAL addresses a track by INDEX, not by name, and the index is 0-based.',
    'This is the one track operation the edit dialogs cannot do at all.',
    'The result is readable from an export: a .mid carries the track name.',
    '',
    'The NIL in the middle is the per-event BODY slot and it is required — a',
    'top-level expression IS that slot, so a track builtin written loose raises',
    '"CAL Error 016: invalid event information or body expression". Equally,',
    'wrapping everything in one (do ...) fails, because then the call is no',
    'longer in the epilog position. Prolog (do), then NIL, then the track call.',
  ])}
(do
  (include "need20.cal")
  (int trk ${trk})
)
NIL
(TrackName "${safe}" trk)
(pause "MCP renameTrack: track " trk " is now " "${safe}")
`;
}

/**
 * (j) Mute or un-mute a track.
 *
 * `TrackActive` is the only mute CAL exposes. The shipped scripts use it only to
 * UN-mute (TRUE) on a freshly created track, so the FALSE direction is a
 * reasonable reading of the same boolean rather than an independently measured
 * fact — stated that way here and in the program's `verified` field.
 */
export function setTrackMuteSource({ trackIndex = 0, mute = true } = {}) {
  const trk = clamp(Math.round(trackIndex), 0, 255);
  const flag = mute ? 'FALSE' : 'TRUE';
  const after = mute ? 'muted' : 'un-muted';
  return `${header(`${mute ? 'Mute' : 'Un-mute'} track ${trk}`, [
    'TrackActive is CAL\'s only mute builtin. The shipped scripts call it with TRUE',
    'and label it "Un-mute the track" (Split Channel to Tracks.cal:40-41), so the',
    'boolean reads as active/enabled: TRUE = audible, FALSE = muted.',
    'There is no solo and no record-arm builtin anywhere in the shipped set.',
    '',
    'Structure: prolog (do), then the required NIL event body, then the track',
    'call in the epilog slot — see the note above the generators.',
  ])}
(do
  (include "need20.cal")
  (int trk ${trk})
)
NIL
(TrackActive ${flag} trk)
(pause "MCP setTrackMute: track " trk " ${after}.")
`;
}

/** (k) Set a track's MIDI channel and/or port. */
export function setTrackRoutingSource({ trackIndex = 0, channel = null, port = null } = {}) {
  const trk = clamp(Math.round(trackIndex), 0, 255);
  const ch = channel === null ? null : clamp(Math.round(channel), 1, 16);
  const pt = port === null ? null : clamp(Math.round(port), 0, 255);
  if (ch === null && pt === null) {
    const e = new Error('setTrackRouting needs a channel, a port, or both.');
    e.code = 'NOTHING_TO_SET';
    throw e;
  }
  const lines = [];
  if (ch !== null) lines.push('(TrackChannel chan trk)');
  if (pt !== null) lines.push('(TrackPort port trk)');
  const decls = ['  (int trk ' + trk + ')'];
  if (ch !== null) decls.push('  (int chan ' + ch + ')');
  if (pt !== null) decls.push('  (int port ' + pt + ')');
  return `${header(`Set track ${trk} routing${ch !== null ? ` channel ${ch}` : ''}${pt !== null ? ` port ${pt}` : ''}`, [
    'TrackChannel and TrackPort are the only routing builtins CAL exposes.',
    'There is no input/output builtin — those live in the UI or the project file.',
    '',
    'Structure: prolog (do), then the required NIL event body, then the track',
    'calls in the epilog slot — see the note above the generators.',
  ])}
(do
  (include "need20.cal")
${decls.join('\n')}
)
NIL
${lines.join('\n')}
(pause "MCP setTrackRouting: track " trk " updated.")
`;
}

/** op name -> generator. Keeps the table and the code from drifting apart. */
export const GENERATORS = {
  setVelocity: setVelocitySource,
  scaleVelocity: scaleVelocitySource,
  addNotes: addNotesSource,
  deleteNotes: deleteNotesSource,
  transpose: transposeSource,
  setDuration: setDurationSource,
  queryNotes: queryNotesSource,
  dumpNotes: dumpNotesSource,
  renameTrack: renameTrackSource,
  setTrackMute: setTrackMuteSource,
  setTrackRouting: setTrackRoutingSource,
};

/** A name for the generated file, derived from the op so re-runs are idempotent. */
export function scriptNameFor(op) {
  return `MCP-${op}.CAL`;
}

/**
 * Write a CAL program into the folder SONAR reads.
 *
 * Follows lib/midi-config.js, which is this project's precedent for editing a
 * file the host owns: resolve the path first and fail loudly if it is missing,
 * do nothing when the content is already identical, back up before the first
 * change, and say when the change actually takes effect.
 */
export function writeScript(name, source, { backup = true, folder = null } = {}) {
  if (!name || !/^[A-Za-z0-9._-]+\.cal$/i.test(name)) {
    const e = new Error(`'${name}' is not a usable CAL filename. Use letters, digits, dot, `
      + 'underscore or dash, ending in .CAL.');
    e.code = 'BAD_SCRIPT_NAME';
    throw e;
  }
  const dir = folder || calFolder();
  if (!existsSync(dir)) {
    const e = new Error(`The CAL folder does not exist: ${dir}. Start SONAR once so it writes its `
      + 'UserPaths registry values, or pass an explicit folder.');
    e.code = 'NO_CAL_FOLDER';
    e.detail = { folder: dir };
    throw e;
  }
  const path = join(dir, name);
  const body = source.endsWith('\n') ? source : `${source}\n`;

  if (existsSync(path)) {
    let current = null;
    try { current = readFileSync(path, 'utf8'); } catch (_) { /* unreadable: overwrite */ }
    if (current === body) {
      return { ok: true, changed: false, path, folder: dir, name,
        note: 'Identical content was already there, so nothing was written.' };
    }
  }

  if (backup && existsSync(path)) {
    // Contract: back up before the first change. The first .bak is the original, so
    // it is kept by later runs; a .bak that cannot be trusted is a hard failure, not
    // something to quietly overwrite along with the source.
    const bakPath = `${path}.bak`;
    const fail = (why) => {
      const e = new Error(`Refusing to overwrite ${path}: the backup at ${bakPath} could not be `
        + `established (${why}). The source was left untouched.`);
      e.code = 'BACKUP_FAILED';
      e.detail = { path, backup: bakPath, why };
      return e;
    };
    if (existsSync(bakPath)) {
      let st;
      try {
        st = statSync(bakPath);
      } catch (err) {
        throw fail(`cannot stat: ${err && err.message ? err.message : String(err)}`);
      }
      if (!st.isFile()) {
        throw fail('it exists but is not a regular file');
      }
      try {
        readFileSync(bakPath);
      } catch (err) {
        throw fail(`it exists but cannot be read: ${err && err.message ? err.message : String(err)}`);
      }
    } else {
      try {
        copyFileSync(path, bakPath);
      } catch (err) {
        throw fail(`copying the source to it failed: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }
  writeFileSync(path, body, 'utf8');

  return {
    ok: true,
    changed: true,
    path,
    folder: dir,
    name,
    bytes: Buffer.byteLength(body, 'utf8'),
    note: 'The file is on disk now. SONAR lists the folder each time the CAL dialog opens, so '
      + 'no restart is needed — but the script only runs when it is chosen in that dialog.',
  };
}

/** Remove a generated script, and its backup, if present. */
export function removeScript(name, { folder = null } = {}) {
  // Same name gate as writeScript, even though today's only caller passes
  // names built by scriptNameFor. The gate is defence in depth: this function
  // deletes files, and its signature accepts any string. If a future caller
  // forwards user input, the check below is what stops '..\..oo' from
  // escaping the CAL folder.
  if (!name || !/^[A-Za-z0-9._-]+\.cal$/i.test(name)) {
    const e = new Error(`'${name}' is not a removable CAL filename.`);
    e.code = 'BAD_SCRIPT_NAME';
    throw e;
  }
  const dir = folder || calFolder();
  const path = join(dir, name);
  const removed = [];
  const failed = [];
  for (const p of [path, `${path}.bak`]) {
    if (!existsSync(p)) continue;
    try { unlinkSync(p); removed.push(p); } catch (e) { failed.push({ path: p, why: e.message }); }
  }
  return { ok: failed.length === 0, path, removed, failed };
}

/**
 * Ensure a document is open before anything that needs the 处理 menu.
 * Same guard, same code, as edit.js and note-edit.js.
 */
export async function requireDocument() {
  const doc = await documentState();
  if (!doc.projectOpen) {
    const e = new Error('No document is open, so there is nothing to edit and no 处理 menu.');
    e.code = 'NO_DOCUMENT';
    throw e;
  }
  return doc;
}

/**
 * Write the script and open the dialog that runs it.
 *
 * This module cannot click (see the header), so it stops here and reports the
 * exact dialog steps for an accessibility runtime. Returns the same shape as
 * openDialogFor, plus what to do next.
 */
export async function openForScript(op, args = {}, { selectFirst = true, waitMs = 1600,
  folder = null, backup = true, confirm } = {}) {
  const entry = CAL_PROGRAMS[op];
  if (!entry) {
    const e = new Error(`unknown CAL program '${op}'. Known: ${Object.keys(CAL_PROGRAMS).join(', ')}`);
    e.code = 'UNKNOWN_PROGRAM';
    throw e;
  }
  const generate = GENERATORS[op];
  if (!generate) {
    const e = new Error(`'${op}' is declared but has no generator — the table and the code have `
      + 'drifted apart.');
    e.code = 'NO_GENERATOR';
    throw e;
  }
  if (op === 'deleteNotes' && confirm !== 'deleteNotes') {
    const e = new Error("'deleteNotes' removes the selected notes in the requested range. Because that "
      + 'is destructive, it must be confirmed by passing confirm: \'deleteNotes\'. Undo may recover them.');
    e.code = 'NEEDS_CONFIRMATION';
    throw e;
  }
  await requireDocument();

  const source = generate(args);
  const name = scriptNameFor(op);
  const written = writeScript(name, source, { backup, folder });

  if (selectFirst && entry.needsSelection) {
    await runCommand(0x804C, { keepOverlays: true });   // 编辑 > 选择 > 全部
    await sleep(700);
  }
  const posted = await runCommand(CAL_COMMAND.cmdId, { keepOverlays: true });
  await sleep(waitMs);

  return {
    ok: true,
    program: op,
    script: written,
    command: { cmdId: CAL_COMMAND.cmdId, hex: CAL_COMMAND.hex, name: CAL_COMMAND.name },
    selectionRequested: selectFirst && entry.needsSelection ? 'posted 编辑 > 选择 > 全部' : null,
    selectionConfirmed: false,
    selectionEvidence: 'select-all is a drawn change; nothing in this process can confirm it',
    posted: posted.posted,
    effect: posted.effect,
    newWindows: posted.newWindows,
    dialogExpectation: RUN_CAL_DIALOG,
    sideEffect: entry.sideEffect,
  };
}

/**
 * The full plan: what to write, what to click, and how to prove it worked.
 *
 * Pure — no file is written and no command is posted. Mirrors quantizePlan so a
 * caller that already drives dialogs needs no new concept.
 */
export function calPlan(op, args = {}) {
  const entry = CAL_PROGRAMS[op];
  if (!entry) {
    const e = new Error(`unknown CAL program '${op}'. Known: ${Object.keys(CAL_PROGRAMS).join(', ')}`);
    e.code = 'UNKNOWN_PROGRAM';
    throw e;
  }
  const source = GENERATORS[op](args);
  const f = RUN_CAL_DIALOG.fields;
  return {
    tool: 'cw_cal_run',
    program: op,
    scriptName: scriptNameFor(op),
    source,
    writesToDisk: { folder: calFolder(), name: scriptNameFor(op) },
    opensDialog: RUN_CAL_DIALOG.title,
    writes: [
      { field: 'filename', label: f.filename.label, kind: f.filename.kind,
        value: scriptNameFor(op),
        resolveBy: 'elements whose title is exactly "文件名(N):" AND whose actions include a '
          + 'set-value action',
        why: f.filename.warning },
    ],
    commit: { action: 'AXPress', label: f.open.label, element: f.open.element },
    afterCommit: 'The script runs immediately. There is no progress UI; the script ends with a '
      + 'modal pause that must be dismissed, and its text is the only thing CAL reports. Do not '
      + 'read the window list in the same breath — the close is asynchronous.',
    verify: {
      why: 'CAL reports only a count in a pause dialog. That is not evidence about note data.',
      how: 'Export with 文件 > 导出 > 标准 MIDI 文件 (0xA659, which opens the 保存副本 dialog) and '
        + 'parse the result with cw_read_midi_file, then compare against the source.',
      control: 'Before concluding the script did nothing, export the SAME content with no CAL run '
        + 'and compare — export on this build is faithful (zero drift), so any difference is the edit.',
    },
    sideEffect: entry.sideEffect,
    risk: CAL_COMMAND.risk,
    riskWhy: CAL_COMMAND.riskWhy,
  };
}

/** Everything about the CAL layer, for cw_cal_help. */
export function calHelp() {
  return {
    summary:
      'CAL is SONAR\'s legacy macro language and it is NOT gated by the membership paywall, '
      + 'unlike CakeScript. It reads and writes note data directly, so it closes the gap the '
      + 'adapter had on a free licence: notes can be created, deleted and read, not only '
      + 'transformed.',
    howToRun: [
      { step: 1, action: 'write a .CAL file into the CAL folder', why: 'the dialog lists that folder' },
      { step: 2, action: '编辑 > 选择 > 全部 (0x804C)', why: 'the body runs once per selected event' },
      { step: 3, action: '处理 > 运行 CAL 程序 (0x806A)', why: 'opens the file dialog' },
      { step: 4, action: `write the filename into element ${RUN_CAL_DIALOG.fields.filename.element}`,
        why: 'the textfield, not the combobox that shares its label' },
      { step: 5, action: `press ${RUN_CAL_DIALOG.fields.open.label}`, why: 'the script executes at once' },
      { step: 6, action: 'dismiss the modal pause', why: 'every generated script ends with one' },
      { step: 7, action: 'export and parse', why: 'the only way to know what the notes became' },
    ],
    programs: CAL_PROGRAMS,
    dialog: RUN_CAL_DIALOG,
    language: {
      structure: 'A sequence of parenthesised expressions. The "prolog / body / epilog" split in '
        + 'the shipped scripts is a convention, not grammar: the body slot is re-evaluated once '
        + 'per selected event. `(forEachEvent expr)` is the explicit form. NIL in the body means '
        + 'no per-event work. IMPORTANT: a top-level expression IS the body slot, so a TRACK '
        + 'builtin written loose fails with "CAL Error 016: invalid event information or body '
        + 'expression". The working shape for a track operation is prolog (do ...), then NIL as '
        + 'the body, then the track call, then the report — measured, and it cost two failed runs.',
      trackBuiltins: {
        '(TrackName "string" idx)': 'rename the track at idx (0-based). MEASURED end to end.',
        '(TrackActive TRUE|FALSE idx)': 'mute control. The shipped comment "; Un-mute the track" '
          + 'sits above (TrackActive TRUE ...), so TRUE = audible, FALSE = muted.',
        '(TrackChannel chan idx)': 'forced MIDI channel.',
        '(TrackPort port idx)': 'output port.',
        '(TrackSelect 0|1 idx)': '(TrackSelect 0 -1) deselects all, then (TrackSelect 1 n) '
          + 'selects one.',
        '__absent__': 'MUTE is TrackActive; SOLO, record-arm, volume, pan and patch have NO CAL '
          + 'builtin — grepping the shipped set for TrackSolo / TrackArm / TrackVolume / TrackPan / '
          + 'TrackPatch returns zero hits.',
      },
      trackIndexing: 'Track indices are 0-based over the project tracks, and the shipped script '
        + 'notes the range as 0..255. An exported .mid places the conductor track first, so CAL '
        + 'track N appears as export track N+1 — measured.',
      variables: '(int name init) (dword name init) (word name init) (string name init). A prolog '
        + 'variable persists across the per-event walk — that is the only cross-event state, and '
        + 'the shipped scripts use it to carry the previous event forward.',
      fields: {
        'Event.Kind': 'NOTE, CONTROL, WHEEL, CHANAFT observed; KEYAFT and PATCH exist via the '
          + 'filter API. Read-only in every shipped usage.',
        'Event.Time': 'absolute tick. Writeable.',
        'Event.Chan': 'MIDI channel. Read-only in every shipped usage.',
        'Note.Key': 'pitch 0..127. Writeable.',
        'Note.Vel': 'velocity 1..127. Writeable.',
        'Note.Dur': 'duration in ticks, 16-bit — wraps at 65535.',
        'Control.Num': 'controller number. Read-only.',
        'Control.Val': 'controller value. Writeable.',
      },
      operators: '== != < > <= >= && ||, arithmetic + - * / % with INTEGER division, and the '
        + 'compound forms ++ -- += -= *= /= which return the new value so they can be nested.',
      builtins: '(insert time chan kind key vel dur), (delete), (message ...), (pause ...), '
        + '(getInt var prompt min max), (getTime var prompt), (format "text" args...), '
        + '(random lo hi), (index), (meas t), (beat t), (tick t), (include "file"), (exit), '
        + '(delay ms), plus the five track builtins listed above.',
    },
    traps: [
      '`insert` RESETS the in-flight event\'s fields — the shipped HARMONYZ.CAL records this. '
        + 'Copy Event.Time/Chan and Note.Key/Vel/Dur into variables BEFORE the first insert, or '
        + 'the second and later inserts land at the wrong time. Every generator here does it.',
      'A TOP-LEVEL EXPRESSION IS THE EVENT-BODY SLOT. A track builtin written loose fails with '
        + '"CAL Error 016: invalid event information or body expression" — measured twice. The '
        + 'shape that works is: prolog (do ...), then NIL as the body, then the track call, then '
        + 'the report. Wrapping the track call inside the same (do) as the prolog fails too, '
        + 'because then it is not in the epilog position.',
      'Durations are 16-bit and wrap at 65535 (STRUM-IT.CAL). Subtracting from a short duration '
        + 'can produce a huge one.',
      'Division is integer and truncates. Do percentages as (* x pct) then (/ ... 100).',
      'A string accumulated across the per-event walk does NOT survive it — measured: the count '
        + 'printed and the data did not. CAL cannot write a file, so large results cannot come '
        + 'back as text; use a track name (queryNotes) or export and parse.',
      '`pause` and `getInt` are modal. Generated scripts never use getInt, so an unattended run '
        + 'is not blocked by a prompt — but every one ends with a pause that needs dismissing.',
      'Case matters for keywords and field names (NOTE, TIMEBASE, Event.Kind). Comment style is '
        + '`;` (any number of them).',
      'Undo covers a whole CAL run (RANDTIME.CAL and STRUM-IT.CAL both say to recover with Edit '
        + '> Undo), and it is the only backstop — there is no preview or confirmation.',
    ],
    readingNotes: {
      best: 'Export to .mid (0xA659) and parse with cw_read_midi_file. No side effect, verified.',
      alternative: 'queryNotes encodes a summary into the track name, which is readable from an '
        + 'export — but it renames the track, so it needs an explicit opt-in.',
      notWorkable: 'Returning a note list as text from CAL. Measured to fail.',
    },
    limits: [
      'Only the eleven programs in this table are generated. Arbitrary CAL can be written by hand '
        + 'and run through the same dialog.',
      'A CAL body sees the SELECTION. It cannot address a track by name or a note by index — the '
        + 'previous-event pattern (a prolog variable plus a -1 sentinel) is how the shipped '
        + 'scripts reach backwards, and it is not reproduced here.',
      'CAL reports progress only through a modal pause. Anything machine-read has to go through '
        + 'an export or a track name.',
      'MCP-*.CAL files are written into the real CAL folder. They are ordinary scripts and can '
        + 'be deleted at any time; cw_cal_help does not clean up after itself.',
    ],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
