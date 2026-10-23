// lib/transport.js — tempo, time signature, loop, metronome, and the transport.
//
// The transport is the one part of SONAR that no automation surface reaches: the
// buttons are drawn, so they carry no accessibility elements, and computer-use
// key events need SONAR to be frontmost (a focus-stealing process refuses them).
// What IS reachable is the command layer, and probing it produced a clean split:
//
//   reachable, verified
//     0x801C 录制          0x801D 播放/停止      0x801F 停止
//     0x80B9 循环开关       0x80FE 设置循环选区
//     0x8171 回放时用节拍器  0x8172 录制时用节拍器
//     0x8072 视图 > 速度     0x8073 视图 > 拍号/调号
//     0x807D 插入速度变更    0x807E 插入拍号变更
//
//   not reachable from here
//     the transport buttons themselves — no element, and no way to confirm a
//     click landed. A command that toggles gives no window to watch, so from
//     this process its effect is unverifiable; see lib/verify.js.
//
// Tempo and time signature are the interesting case: a MIDI file carries both as
// meta events, so the reliable way to SET them is to write the file and import
// it. The commands above insert a *change* at the now-time, which is a different
// operation — worth having, but not a substitute.

import { call } from '../bridge/agent.js';
import { runCommand } from './menu.js';
import { documentState } from './track-ui.js';

/** Transport and timing commands, measured against 32.10.0.021. */
export const TRANSPORT_COMMANDS = {
  play: { cmdId: 0x801D, hex: '0x801D', name: '播放/停止', en: 'Play/Stop' },
  stop: { cmdId: 0x801F, hex: '0x801F', name: '停止', en: 'Stop' },
  record: { cmdId: 0x801C, hex: '0x801C', name: '录制', en: 'Record' },
  toggleLoop: { cmdId: 0x80B9, hex: '0x80B9', name: '循环开关', en: 'Loop toggle' },
  setLoopSelection: { cmdId: 0x80FE, hex: '0x80FE', name: '设置循环选区', en: 'Set loop from selection' },
  metronomePlayback: { cmdId: 0x8171, hex: '0x8171', name: '回放时使用节拍器', en: 'Metronome during playback' },
  metronomeRecord: { cmdId: 0x8172, hex: '0x8172', name: '录制时使用节拍器', en: 'Metronome during recording' },
  tempoRatio1: { cmdId: 0x8006, hex: '0x8006', name: '速度比率 1', en: 'Tempo ratio 1' },
  tempoRatio2: { cmdId: 0x8007, hex: '0x8007', name: '速度比率 2', en: 'Tempo ratio 2' },
  tempoRatio3: { cmdId: 0x8008, hex: '0x8008', name: '速度比率 3', en: 'Tempo ratio 3' },
  showTempoView: { cmdId: 0x8072, hex: '0x8072', name: '视图 > 速度', en: 'Views > Tempo' },
  showMeterView: { cmdId: 0x8073, hex: '0x8073', name: '视图 > 拍号/调号', en: 'Views > Meter/Key' },
  insertTempoChange: { cmdId: 0x807D, hex: '0x807D', name: '工程 > 插入速度变更', en: 'Insert tempo change' },
  insertMeterChange: { cmdId: 0x807E, hex: '0x807E', name: '工程 > 插入拍号/调号变更', en: 'Insert meter change' },
  /* Transport states, for reference. */
  seeking: { cmdId: 0x801F, hex: '0x801F', name: '定位到开始 (via 停止)', en: 'Locate to start' },
};

/** Which of these change something a window diff can see (none of them do). */
export const TRANSPORT_EVIDENCE =
  'Every command here changes state without opening a window. This process therefore cannot '
  + 'confirm any of them — it can only post and report that it posted. A computer-use runtime is '
  + 'the witness: the transport buttons light up, the now-time advances, and the loop button '
  + 'toggles visibly. Treat a "posted" result as intent, not as an accomplished change.';

/**
 * Send a transport or timing command.
 *
 * Returns what was posted and, honestly, that this process cannot confirm it.
 * `expectedVisibleEffect` names what a computer-use runtime should look at.
 */
export async function transportCommand(key) {
  const cmd = TRANSPORT_COMMANDS[key];
  if (!cmd) {
    const e = new Error(`unknown transport command '${key}'. Known: ${Object.keys(TRANSPORT_COMMANDS).join(', ')}`);
    e.code = 'UNKNOWN_COMMAND';
    throw e;
  }
  const doc = await documentState();
  if (!doc.projectOpen) {
    const e = new Error(
      'No document is open, so the transport has nothing to move and the 工程 menu (which holds '
      + 'the tempo and meter commands) is not in the menu bar at all.'
    );
    e.code = 'NO_DOCUMENT';
    throw e;
  }

  const posted = await runCommand(cmd.cmdId, { keepOverlays: true });
  return {
    ok: true,
    posted: cmd.name,
    cmdId: cmd.cmdId,
    hex: cmd.hex,
    confirmed: false,
    evidence: TRANSPORT_EVIDENCE,
    expectedVisibleEffect: expectedEffectFor(key),
  };
}

function expectedEffectFor(key) {
  switch (key) {
    case 'play': return 'The play button lights and the now-time advances.';
    case 'stop': return 'The transport stops and the now-time holds where it stopped.';
    case 'record': return 'The record button lights and the transport rolls. A track must be armed '
      + 'for anything to be captured; use cw_set_track_arm on a visible track and check verified.';
    case 'toggleLoop': return 'The loop button in the transport toolbar changes state.';
    case 'setLoopSelection': return 'The loop range brackets the current selection on the time ruler.';
    case 'metronomePlayback':
    case 'metronomeRecord': return 'The metronome button in the transport toolbar changes state.';
    case 'showTempoView': return 'A tempo track appears above the ruler (TEMPOTRACKVIEW in the tree).';
    case 'showMeterView': return 'A meter/key track appears above the ruler.';
    case 'insertTempoChange': return 'A tempo marker appears at the now-time on the tempo track.';
    case 'insertMeterChange': return 'A meter marker appears at the now-time.';
    default: return undefined;
  }
}

/**
 * How to set tempo and time signature for a whole piece.
 *
 * Two routes, and they are not equivalent:
 *   - Write them into a .mid and import it. This sets the piece's tempo map
 *     exactly, with no interaction and no confirmation needed, because the values
 *     are part of the file. Recommended for generating a piece from scratch.
 *   - Insert a change at the now-time with the commands above, which needs the
 *     tempo track visible to confirm and only affects the position it lands on.
 */
export const TEMPO_RECIPES = {
  viaFile: {
    how: 'cw_write_midi_file with a bpm argument, then import. The tempo and 4/4 are written into '
      + 'the conductor track as meta events, so SONAR adopts them with no further action.',
    verified: 'A file written at 120 BPM imported and the transport reported 120.00 / 4/4.',
    caveat: 'Opening a filename that is already loaded does nothing — write to a new name.',
  },
  viaCommand: {
    how: 'Show the tempo view (0x8072), locate, then insertTempoChange (0x807D).',
    caveat: 'Inserts a change at the now-time rather than setting a global tempo, and its effect '
      + 'can only be confirmed visually.',
  },
};

/** Read back what can be known about timing without a computer-use runtime. */
export async function timingState() {
  const doc = await documentState();
  return {
    document: doc.projectOpen ? doc.project : null,
    // The now-time, tempo and meter are drawn, not exposed — with one exception:
    // a MIDI file's conductor track is data, so a file the adapter wrote is the
    // one place these values can be read back without a runtime.
    readableFromHere: false,
    howToRead: 'Read them off the transport bar (now-time) and the toolbar (tempo, meter) with a '
      + 'computer-use runtime, or parse the .mid file that was imported — see cw_read_midi_file.',
    note: 'The transport toolbar shows now-time in Bars|Beats, tempo and meter as text fields, so '
      + 'they are legible in a screenshot even though they are not accessibility elements.',
  };
}
