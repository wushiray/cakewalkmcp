// lib/server.js — MCP server: tool definitions and request handlers.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runTemplate, hostStatus } from './run.js';
import { findSonar, sonarVersion, calFolder } from './sonar.js';
import { capabilities, runCommand, TRANSPORTS } from './dispatch.js';
import { liveCommands, searchCommands, listOverlays, closeOverlays, commandIndexPath } from './menu.js';
import * as live from './live.js';
import { probePlan, reportState, getState, listState, SURFACES } from './project-state.js';
import { readConfig, enablePort, midiConfigSummary, configPath } from './midi-config.js';
import { commandSupportSummary, verifyCommands, WORKING_NO_PROJECT, WORKING_WITH_PROJECT, UI_RECIPE } from './commands.js';
import { documentState, trackAccessPlan, TRACK_CONTROLS, CONTAINERS, VIEW_COMMANDS,
         readTrackControl, setTrackControl, renameTrack, listTrackTemplates,
         insertTrackTemplate } from './track-ui.js';
import { doctor } from './doctor.js';
import { pluginSummary, findPlugins, songInstruments, loadLayout, categoryOf, scannedPlugins, layoutOnlyPlugins, PLUGIN_INSERT_RECIPE } from './plugins.js';
import { addTrack, addSongSkeleton, INSERT_COMMANDS, SONG_SKELETON } from './tracks.js';
import * as mixer from './mixer.js';
import { runBenchmark, latencyProfile, surveyTrackWrites } from './benchmark.js';
import * as midiFile from './midi-file.js';
import { runAndClassify, evidenceSummary, COMMAND_EVIDENCE, EVIDENCE, NO_EFFECT_CAUSES } from './verify.js';
import { edit, editHelp, EDIT_COMMANDS, EDIT_DIALOGS } from './edit.js';
import { noteEditHelp, quantizePlan, transposePlan, judgeQuantize, predictQuantize, gridTicks,
  QUANTIZE_DIALOG, TRANSPOSE_DIALOG } from './note-edit.js';
import { calPlan, calHelp, openForScript, CAL_PROGRAMS, CAL_COMMAND, RUN_CAL_DIALOG,
  writeScript, removeScript, scriptNameFor, GENERATORS } from './cal-script.js';
import { undo, redo, openHistory, historyHelp, HISTORY_COMMANDS, HISTORY_DIALOG } from './history.js';
import { convert, convertHelp, NOTE_VALUES, PPQ } from './convert.js';
import { surfaceStatus, surfaceSet, surfaceDiag, surfaceParams, surfaceHelp,
  surfaceMidiIn, surfaceDump, surfaceRead,
  SURFACE_PARAMS, isKnownParam, closeSurfaceClient } from './surface.js';
import { startJob, getJob, listJobs, abandonJob, clearJobs, jobHelp } from './jobs.js';
import { projectCommand, PROJECT_COMMANDS, FILE_DIALOG, saveState } from './project.js';
import { transportCommand, TRANSPORT_COMMANDS, TEMPO_RECIPES, timingState } from './transport.js';
import { navigate, markerHelp, NAV_COMMANDS, MARKER_COMMANDS, ARRANGER_COMMANDS } from './navigate.js';

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function errResult(err) {
  const lines = [`Error: ${err.message}`];
  if (err.code) lines.push(`[${err.code}]`);
  // A hint is the part that says what to do about it, so it belongs in the
  // message rather than only in the structured detail.
  if (err.hint) { lines.push(''); lines.push(`Hint: ${err.hint}`); }
  if (err.detail && err.code === 'CAKESCRIPT_UNAVAILABLE') {
    lines.push('');
    lines.push('Transports:');
    for (const [name, t] of Object.entries(err.detail.transports || {})) {
      lines.push(`  ${name}: ${t.available ? 'available' : 'unavailable'} — ${t.detail}`);
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

/**
 * Report both failures when a tool has two transports.
 *
 * A track-flag write tries the track strip first and CakeScript second. When both
 * fail, only showing the second error is actively misleading: on a build without
 * CakeScript the second is always "CAKESCRIPT_UNAVAILABLE", which hides the
 * first — and the first is the one that says whether the track was visible, or
 * whether a project was open at all.
 */
function withBothErrors(primary, secondary) {
  const e = new Error(
    `${primary.message}\n\n(also tried the CakeScript transport, which failed too: ${secondary.message})`);
  // Keep the structured detail of whichever error carries transport info, so
  // errResult still prints the transport table.
  e.detail = primary.detail || secondary.detail;
  e.code = primary.detail ? primary.code : secondary.code;
  return e;
}

/**
 * Rewrite a CAKESCRIPT_UNAVAILABLE failure for a tool whose ONLY implementation
 * is a CakeScript template, appending what to use instead.
 *
 * Without this, such a tool answers with the generic transport blocker — which
 * lists four *categories* of alternative (menu commands, MIDI/ACT, edit dialogs,
 * computer-use) and never says which one applies to the call that just failed. A
 * caller reads that, tries a variation of the same dead call, and gets the same
 * message. Naming the replacement in the tool's own vocabulary is the difference
 * between "something went wrong" and "not here, do this instead".
 *
 * @param {string} alternative what to call instead, phrased as an instruction
 */
function t1Only(alternative) {
  return (e) => {
    if (!e || e.code !== 'CAKESCRIPT_UNAVAILABLE') return e;
    const wrapped = new Error(
      `${e.message}\n\nThis tool has no second implementation on this build, so no fallback ran. `
      + `Use instead: ${alternative}`);
    wrapped.code = e.code;
    wrapped.detail = e.detail;
    return wrapped;
  };
}

/** True when an error is the "CakeScript cannot be dispatched here" blocker. */
function isT1Blocker(e) {
  return !!(e && ['CAKESCRIPT_UNAVAILABLE', 'T1_CHAIN_UNIMPLEMENTED'].includes(e.code));
}

export function buildServer() {
  // Single source of truth. The literal here said 0.2.0 while package.json said
  // 0.1.0, so a client could not tell which build it was talking to. Read the
  // package's own version; fall back only if the file is not beside lib/.
  let version = '0.0.0';
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    version = JSON.parse(readFileSync(pkg, 'utf8')).version || version;
  } catch { /* packaged without package.json: the fallback is honest */ }
  const server = new McpServer(
    { name: 'cakewalk-mcp', version },
    { capabilities: { tools: {} } }
  );

  // ----- diagnostics -----

  server.tool(
    'cw_doctor',
    'Run a health check across every transport channel (host / CakeScript / WM_COMMAND / surface '
    + 'bridge / realtime MIDI / UIA click), each with a verdict and a remedy. THE tool to run first '
    + 'after a SONAR upgrade: it names which paths degraded and what to update.',
    {},
    async () => { try { return textResult(await doctor()); } catch (e) { return errResult(e); } });

  server.tool(
    'cw_status',
    'Check SONAR host, which automation transports this build supports, and what to use. Run this first.',
    { refresh: z.boolean().default(false).describe('Re-probe now instead of using the 3 s cache') },
    async ({ refresh }) => {
      try {
        const host = hostStatus();
        // Was refresh:true on every call, i.e. three synchronous child processes
        // per status check (~1.4 s, blocking all other requests). The cache now
        // expires on its own; an explicit refresh is still available.
        const caps = await capabilities({ refresh });
        let midi = null;
        try { midi = await live.liveStatus(); } catch (e) { midi = { available: false, error: e.message }; }
        let doc = null;
        try { doc = await documentState(); } catch (e) { doc = { known: false, reason: e.message }; }
        // tasklist and the window bridge are independent probes. When the process
        // exists but no window answers, saying running:true beside document
        // known:false is a contradiction the caller has to resolve itself.
        const notes = [];
        if (host.sonar_running && doc && doc.known === false) {
          notes.push('The SONAR process exists but its main window did not answer: it is starting, '
            + 'busy, or hung. Wait a moment and retry before restarting it.');
        }
        return textResult({
          sonar: {
            path: host.sonar_path,
            running: host.sonar_running,
            version: host.sonar_path ? sonarVersion(host.sonar_path) : null,
          },
          document: doc,
          transports: caps.transports,
          realtimeMidi: midi,
          wmCommandSupport: {
            worksAlways: WORKING_NO_PROJECT.length,
            worksWithProject: WORKING_WITH_PROJECT.length,
            detail: 'Whether a command responds depends on whether a project is open. '
              + 'cw_command_support explains; cw_document_state says which case you are in.',
          },
          recommended: caps.recommended,
          notes: [...notes, ...(caps.notes || [])],
          commandIndex: commandIndexPath(),
        });
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_list_overlays',
    'List modal windows (the Assistant / command-palette panel) that block menu commands.',
    {},
    async () => { try {
      const r = await listOverlays();
      // The bridge answers {error:'sonar not running'} rather than throwing, so
      // this used to come back as a SUCCESS result carrying an error field.
      if (r && r.error) { const e = new Error(r.error); e.code = 'SONAR_UNAVAILABLE'; throw e; }
      return textResult(r);
    } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_close_overlays',
    'Close transient panels. Standard dialogs, including unsaved-work prompts, are preserved by '
    + 'default. Dismissing them may discard work and requires closeDialogs:true and confirm:"closeDialogs".',
    { closeDialogs: z.boolean().default(false), confirm: z.string().optional() },
    async (args) => { try {
      const r = await closeOverlays(args);
      if (r && r.error) { const e = new Error(r.error); e.code = 'SONAR_UNAVAILABLE'; throw e; }
      return textResult(r);
    } catch (e) { return errResult(e); } }
  );

  // ----- version-independent command transport -----

  server.tool(
    'cw_ui_recipe',
    'How to drive SONAR\'s own UI with a computer-use runtime: which parts are reachable, which are '
    + 'not, and how to recover when a JUCE modal dialog blocks the app. Measured, not guessed — '
    + 'notably, synthetic keystrokes do not reach SONAR and the menu bar is reachable via AXExpand.',
    {},
    async () => { try { return textResult(UI_RECIPE); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_command_support',
    'What WM_COMMAND can actually drive in this SONAR build, measured. Working commands are '
    + 'main-frame ones (Preferences, About, Assistant, Video Engine, Reset MIDI/Audio). The 视图 '
    + 'menu, CakeScript and per-track mixer commands are registered but not dispatched, so posting '
    + 'them does nothing — this tool says so up front instead of leaving you to discover it.',
    {},
    async () => { try { return textResult(await commandSupportSummary()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_verify_commands',
    'Re-measure which command ids do something on the running SONAR, by posting each and watching '
    + 'the window list. Use after a SONAR update to refresh the working/inert split. Defaults to the '
    + 'two safe view commands when a project is open; nothing without a project. '
    + 'Only a fixed view/dialog allowlist is probed, even for explicit ids. A modal stops the '
    + 'survey and is left open. No insert, recording, mute, solo or document lifecycle probes. '
    + 'Cost, measured: each probe takes about 15s (two bridge round trips plus a settle delay), so '
    + 'the full 21-command survey is roughly five minutes and NO budget makes it quick — a short '
    + 'budget buys one or two probes, which is a much weaker claim than a complete survey. `probed` '
    + 'says how many were actually measured; give it time if you want the measurement.',
    {
      cmdIds: z.array(z.number().int().min(0)).optional()
        .describe('Ids from the safe view/dialog allowlist; other ids are reported as notProbed'),
      budgetMs: z.number().int().min(1000).max(300_000).default(12_000)
        .describe('Cap the survey. At ~15s per probe this buys about one probe; the default is a '
          + 'bound for a caller who wants a sample, not a useful survey. Allow ~300000 for all 21.'),
      background: z.boolean().default(false)
        .describe('Return a job id immediately and run the survey in the background; poll cw_job'),
    },
    async ({ cmdIds, budgetMs, background }) => {
      try {
        if (background) {
          // The five cw_job* tools had no producer: startJob was imported and
          // never called, so every job query returned "no such job". A 5-minute
          // survey is exactly the kind of call that needs one.
          const job = startJob('verify', () => verifyCommands(cmdIds, { budgetMs }), {
            detail: { budgetMs, cmdIds: cmdIds || null },
          });
          return textResult({ job: job.id, state: job.state, poll: `cw_job { id: '${job.id}' }` });
        }
        return textResult(await verifyCommands(cmdIds, { budgetMs }));
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_list_commands',
    'List SONAR commands. source="live" (default) lists ids that cw_run_command can actually post, '
    + 'read from the running build\'s menu bar. source="index" searches SONAR\'s command-palette index '
    + '(broader, but those ids are not postable).',
    {
      source: z.enum(['live', 'index']).default('live'),
      query: z.string().optional().describe('Case-insensitive substring filter'),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ source, query, limit }) => {
      try {
        if (source === 'index') {
          const rows = searchCommands(query || '', limit);
          return textResult({
            source: 'index',
            note: 'Index CMD_IDs are NOT postable via WM_COMMAND; use source="live" ids with cw_run_command.',
            count: rows.length,
            commands: rows,
          });
        }
        const all = await liveCommands();
        const q = (query || '').toLowerCase();
        const filtered = q ? all.filter((c) => c.path.toLowerCase().includes(q)) : all;
        return textResult({
          source: 'live',
          note: 'These cmdIds come from GetMenuItemID on the running process and can be posted.',
          count: filtered.length,
          commands: filtered.slice(0, limit),
        });
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_run_command',
    'Run a SONAR menu command by numeric id via WM_COMMAND. Version-independent: works on any build '
    + 'whose menu exposes the command. Get ids from cw_list_commands. Returns whether the window list '
    + 'changed, so a registered-but-unhandled command is distinguishable from a working one.',
    {
      cmdId: z.number().int().min(0).describe('Menu command id, e.g. 34861 (0x882D Preferences)'),
      keepOverlays: z.boolean().default(false).describe('Do not close modal panels first'),
      confirm: z.string().optional().describe(
        'Required for destructive ids (0xE102 File > Close, 0x853D Revert). Pass "close" or "revert" to acknowledge'),
    },
    async ({ cmdId, keepOverlays, confirm }) => {
      try {
        // The gate lives in lib/menu.js runCommand, so every caller inherits it
        // (classified / verify included). This tool only forwards the
        // acknowledgement.
        return textResult(await runCommand(cmdId, { keepOverlays, confirm }));
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_document_state',
    'Whether SONAR has a document open, read from the window title — the one piece of project '
    + 'state this process can see. This gates a lot: with no project the menu bar has only the '
    + 'application-level menus and the track controls do not exist, which makes view and document '
    + 'commands look broken. With a project open the menu tree is 270 entries and the track '
    + 'strips appear.',
    {},
    async () => { try { return textResult(await documentState()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_track_controls',
    'How to read and change tracks through SONAR\'s accessibility tree, which is the working path '
    + 'on builds with no CakeScript. Gives the element naming ("音量 on Track 17"), which controls '
    + 'each strip type has, and which action each takes. The elements are only reachable from a '
    + 'computer-use runtime — this server ships the contract, it cannot read them itself.',
    {},
    async () => { try { return textResult(await trackAccessPlan()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_view_commands',
    'Commands that open SONAR views, with the caveat that matters: a view opening inside the '
    + 'existing frame produces NO new window, so cw_run_command reports "none-observed" for all of '
    + 'them even when they worked. Verify a view by reading the accessibility tree or a screenshot.',
    {},
    async () => {
      try {
        return textResult({
          commands: VIEW_COMMANDS,
          caveat: 'A window diff cannot see a view that opens inside the current frame. '
            + '"none-observed" here means "no new top-level window", not "nothing happened".',
          howToVerify: 'After the command, check whether the expected pane appears in the '
            + 'accessibility tree (e.g. CTRACKVIEW, CCLIPSVIEW) or take a screenshot.',
        });
      } catch (e) { return errResult(e); }
    }
  );

  // ----- plugins -----

  server.tool(
    'cw_plugins',
    'Summarise the plugins SONAR has registered: counts, categories, and any registered plugin '
    + 'whose file is missing. Reads SONAR\'s own scan result, so it works whether or not SONAR is '
    + 'running.',
    {},
    async () => { try { return textResult(pluginSummary()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_find_plugin',
    'Search registered plugins by name. Covers effects and instruments; instruments are the ones '
    + 'to load into a track. Each result carries its CLSID, its file path, and whether the file is '
    + 'still present.',
    {
      query: z.string().describe('Substring to match against plugin name or file path, e.g. "bass"'),
      kind: z.enum(['instrument', 'effect']).optional(),
      limit: z.number().int().min(1).max(200).default(40),
      presentOnly: z.boolean().default(true).describe('Hide plugins whose file is missing'),
    },
    async ({ query, kind, limit, presentOnly }) => {
      try {
        return textResult({
          query,
          results: findPlugins(query, { kind, limit, includeMissing: !presentOnly }),
        });
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_plugin_insert_recipe',
    'How far plugin insertion can be driven on this build: discovery works (open the browser, list '
    + 'categories, read which plugin is selected), insertion does not (click, double-click and drag '
    + 'all leave the FX bin empty). Read this before promising a plugin can be attached.',
    {},
    async () => { try { return textResult(PLUGIN_INSERT_RECIPE); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_song_instruments',
    'Instruments available for songwriting, grouped by the role each suits (drums, bass, keys, '
    + 'guitar, strings, synth), best pick first. Derived from the registered instruments.',
    {
      limitPerRole: z.number().int().min(1).max(20).default(4),
    },
    async ({ limitPerRole }) => {
      try { return textResult(songInstruments({ limitPerRole })); } catch (e) { return errResult(e); }
    }
  );

  // ----- tracks -----

  server.tool(
    'cw_add_track',
    'Add a track to the open project via SONAR\'s 插入 menu. kind: midi | audio | bus | folder | aux. '
    + 'Requires a project to be open — the 插入 menu does not exist without one. Reports whether the '
    + 'project title gained its modified marker, which is the only insert confirmation available '
    + 'without a computer-use runtime.',
    {
      kind: z.enum(['midi', 'audio', 'bus', 'folder', 'aux']).default('midi'),
      name: z.string().optional().describe('Intended track name; applied only as a hint'),
    },
    async (a) => { try { return textResult(await addTrack(a.kind, a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_add_song_tracks',
    'Add the tracks a simple arrangement needs: drums, bass, keys, guitar, strings, synth — in that '
    + 'order, one MIDI track each. Pass roles to add only some. Each track gets SONAR\'s default '
    + 'instrument; loading a specific plugin is a separate UI step. '
    + 'Cost, measured: one insert takes ~19s (a menu post plus a verification wait), so the full '
    + 'six-track skeleton needs roughly two minutes. Pass roles and a matching budgetMs together '
    + 'rather than asking for all six.',
    {
      roles: z.array(z.enum(['drums', 'bass', 'keys', 'guitar', 'strings', 'synth'])).optional(),
      /*
       * 10s was wrong for this workload: a single insert measured ~19s, so the
       * default could not complete even one track. 45s covers two on a good run and
       * returns a usable partial with the rest named, which is the honest shape for
       * a default; a caller who wants all six raises it.
       */
      budgetMs: z.number().min(1000).max(600_000).default(45_000)
        .describe('Stop adding after this long and report which roles were not attempted. One '
          + 'insert takes ~19s, so the default covers about two tracks; allow ~120s for all six.'),
    },
    async ({ roles, budgetMs }) => {
      try { return textResult(await addSongSkeleton({ roles, budgetMs })); } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_insert_commands',
    'Every 插入 (Insert) command SONAR exposes, with its id. Reference for cw_run_command when you '
    + 'need something cw_add_track does not cover, e.g. a track template.',
    {},
    async () => {
      try {
        return textResult({
          commands: INSERT_COMMANDS,
          songSkeleton: SONG_SKELETON,
          note: 'These are document-scoped: they respond only when a project is open.',
        });
      } catch (e) { return errResult(e); }
    }
  );

  // ----- selection, navigation, markers -----

  server.tool(
    'cw_navigate',
    'Selection, navigation and marker commands: selectAll | selectNone | selectByTime | '
    + 'selectFromNow | selectToNow | selectToEnd | goToNextMeasure | goToPrevMeasure | '
    + 'goToPrevMarker | goToNextMarker | insertMarker | setProjectStart | setProjectEnd | '
    + 'setProjectRange | toggleProjectMarkers | removeProjectStart | removeProjectEnd | '
    + 'removeProjectRange | showMarkerView. Reports whether the result is a readable dialog or a '
    + 'drawn change this process cannot confirm.',
    {
      command: z.enum(['selectAll', 'selectNone', 'selectByTime', 'selectFromNow', 'selectToNow',
        'selectToEnd', 'goToNextMeasure', 'goToPrevMeasure', 'goToPrevMarker', 'goToNextMarker',
        'insertMarker', 'setProjectStart', 'setProjectEnd', 'setProjectRange',
        'toggleProjectMarkers', 'removeProjectStart', 'removeProjectEnd', 'removeProjectRange',
        'showMarkerView']),
      confirm: z.string().optional().describe(
        'Required for the three removeProject* commands: pass the command name back to acknowledge'),
    },
    async ({ command, confirm }) => { try { return textResult(await navigate(command, { confirm })); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_markers',
    'Everything about markers: the dialog (which IS writable, unlike SONAR\'s own controls), the '
    + 'commands, and how to read the marker list back. This is the working pattern for a drawn '
    + 'surface that has a command opening an MFC dialog behind it.',
    {},
    async () => { try { return textResult({ ...markerHelp(), arranger: ARRANGER_COMMANDS }); } catch (e) { return errResult(e); } }
  );

  // ----- editing and processing -----

  server.tool(
    'cw_edit',
    'Run an editing command: quantize | grooveQuantize | transpose | splitClips | splitAtNow | '
    + 'splitMidiNotes | mergeClips | gain | normalize | reverse | removeSilence | fadeEnvelope. '
    + 'Every one needs a selection, which this tool satisfies first — that precondition is the '
    + 'difference between "the command does nothing" and "it opens its dialog".',
    {
      command: z.enum(['quantize', 'grooveQuantize', 'transpose', 'splitClips', 'splitAtNow',
        'splitMidiNotes', 'mergeClips', 'gain', 'normalize', 'reverse', 'removeSilence',
        'fadeEnvelope']),
      confirm: z.string().optional()
        .describe("Required for the destructive ones, e.g. confirm: 'normalize'"),
      selectFirst: z.boolean().default(true),
    },
    async (a) => { try { return textResult(await edit(a.command, a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_edit_help',
    'The editing layer: the commands, their preconditions, the dialogs behind them, and the '
    + 'three-cause taxonomy for "a probe reported nothing happened".',
    {},
    async () => { try { return textResult(editHelp()); } catch (e) { return errResult(e); } }
  );

  // ----- note-level editing -----

  server.tool(
    'cw_note_edit_help',
    'How note-level editing actually works: notes cannot be READ through any automation '
    + 'surface, but they can be EDITED through the dialog behind 处理 > 量化, and the exported '
    + '.mid file is what proves it. Carries the measured field labels, the two mistakes that '
    + 'produced wrong conclusions, and the full verification round trip.',
    {},
    async () => { try { return textResult(noteEditHelp()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_quantize_plan',
    'The exact plan for a quantize: which dialog fields to write, with what values, and how to '
    + 'prove afterwards that it landed. This process cannot perform the accessibility writes '
    + 'itself — a computer-use runtime does that — so this states the plan rather than pretending '
    + 'to run it. Pass the settings you want to get the concrete values.',
    {
      grid: z.string().default('16 分音符')
        .describe('The grid to snap to, as the dialog spells it: 4 分音符, 8 分音符, 16 分音符, ...'),
      strength: z.number().min(0).max(100).default(100)
        .describe('How far notes move toward the grid. 100 lands them on it; 50 moves them half '
          + 'way and is the dialog\'s persisted default, which makes a working quantize look broken.'),
      sensitivity: z.number().min(0).max(100).default(100),
      swing: z.number().min(0).max(100).default(50).describe('50 is straight'),
      offset: z.number().default(0).describe('Ticks to shift the grid by'),
    },
    async (a) => { try { return textResult(quantizePlan(a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_transpose_plan',
    'The exact plan for a transpose: which 移调 dialog fields to write, with what values, and '
    + 'how to prove the commit landed. Transpose is the one note operation that changes PITCH, '
    + 'and it works on a free licence — no CakeScript needed. This process cannot perform the '
    + 'accessibility writes itself (a computer-use runtime does that), so this states the plan '
    + 'rather than pretending to run it.',
    {
      semitones: z.number().int().min(-127).max(127).default(0)
        .describe('The interval to transpose by. SIGNED: negative transposes down. 0 is the '
          + 'dialog default and means "shift by nothing".'),
      wholeTones: z.boolean().default(false)
        .describe('When true, the interval counts whole tones instead of semitones ' +
          '(ticks 全音数(D) in the dialog).'),
    },
    async (a) => { try { return textResult(transposePlan(a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_cal_help',
    'CAL is SONAR\'s legacy macro language and it is NOT behind the membership paywall, unlike '
    + 'CakeScript. It reads and writes note data directly, so on a free licence it is the only '
    + 'way to CREATE, DELETE or READ notes — the dialogs can only transform existing ones. This '
    + 'returns the language reference (fields, operators, builtins), the run procedure, the '
    + 'generated programs, and the traps that cost real time to find.',
    {},
    async (a) => { try { return textResult(calHelp()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_cal_cleanup',
    'Delete the CAL script files cw_cal_run wrote, and their .bak copies. Running CAL leaves a '
    + 'file in the real CAL folder alongside the 37 shipped scripts, so this exists to put the '
    + 'folder back. Only names matching the generated MCP-<program>.CAL pattern are removeable — '
    + 'this will not touch a script you wrote by hand.',
    {
      program: z.enum(Object.keys(CAL_PROGRAMS)).optional()
        .describe('Remove just this program\'s file. Omit to remove every generated script.'),
    },
    async (a) => {
      try {
        const { CAL_PROGRAMS: progs, scriptNameFor: nameFor, removeScript: rm } =
          await import('./cal-script.js');
        const names = a.program ? [nameFor(a.program)] : Object.keys(progs).map(nameFor);
        const results = names.map((n) => rm(n));
        return textResult({
          removed: results.flatMap((r) => r.removed),
          failed: results.flatMap((r) => r.failed || []),
          note: 'Only generated MCP-*.CAL files are targeted; the shipped scripts are never '
            + 'matched by this pattern.',
        });
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_undo',
    'Rewind the most recent operation. Undo opens no window and changes no element, so this '
    + 'process CANNOT confirm it — expect effect "none-observed", which is the SUCCESS case, not '
    + 'a failure. To check it worked, look at the data the operation had changed (a note count, '
    + 'an export), never at the screen. This is the adapter\'s only rewind, and it is what makes '
    + 'an uncertain write safe.',
    {},
    async () => { try { return textResult(await undo()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_redo',
    'Reapply the operation most recently undone. Same silent behaviour as cw_undo — no window, '
    + 'no element change, so the result cannot be confirmed from the screen.',
    {},
    async () => { try { return textResult(await redo()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_history',
    'Open 编辑 > 历史 (0x8044) and report how to read and use the undo stack. The dialog lists '
    + 'every undoable operation as a row, OLDEST FIRST, which makes this the one place in this '
    + 'host where the write history is legible rather than inferred. Reading it changes nothing; '
    + 'choosing an older row and pressing 确定 rewinds TO that point and DISCARDS everything '
    + 'after it — so for a single step use cw_undo instead. Note the stack is depth-limited '
    + '(measured 128) and old entries are dropped silently.',
    {},
    async () => { try { return textResult(await openHistory()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_history_help',
    'How undo/redo work here, the undo-stack dialog as measured, why the stack is the backstop '
    + 'for every irreversible write path, and the trap in verifying a rewind (a window diff sees '
    + 'nothing, so "none-observed" reads like failure when it is success).',
    {},
    async () => { try { return textResult(historyHelp()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_convert',
    'Convert between ticks, bar:beat:tick and seconds. Pure arithmetic — it needs no project and '
    + 'works with SONAR closed, so a measurement already in hand can be converted without waking '
    + 'anything. Pass exactly one of: ticks | time ("1:01:000") | seconds | bar. Note the bases: '
    + 'bare numbers are BARS, and in bar:beat:tick only the final field is 0-based — 1:01:000 is '
    + 'the start of a project, which is what a freshly opened one reads.',
    {
      ticks: z.number().min(0).optional().describe('A tick count to convert.'),
      time: z.string().optional()
        .describe('A bar:beat:tick position as SONAR displays it, e.g. "1:01:000" or "5:02:120". '
          + 'Bar and beat are 1-based; the tick field is 0-based.'),
      seconds: z.union([z.number().min(0), z.string()]).optional()
        .describe('A time in seconds, or as "mm:ss.mmm".'),
      bar: z.number().min(1).optional().describe('A bar number (1-based).'),
      bpm: z.number().min(1).max(1000).default(120)
        .describe('Tempo for the seconds conversion. Only seconds depend on it.'),
      timeSig: z.array(z.number().int().positive()).length(2).default([4, 4])
        .describe('Time signature as [numerator, denominator]. Affects only bars and beats.'),
    },
    async (a) => {
      try {
        const { bpm, timeSig, ...input } = a;
        return textResult(convert(input, { bpm, timeSig }));
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_convert_help',
    'The time units this project uses, the 1-based/0-based trap in bar:beat:tick, the grid note '
    + 'values in ticks, and what the conversions cannot do (tempo changes).',
    {},
    async () => { try { return textResult(convertHelp()); } catch (e) { return errResult(e); } }
  );

  // ----- control-surface bridge (OPT-IN, off by default) -----
  //
  // These reach the cw_surface plugin loaded inside SONAR. They are registered
  // only when CAKEWALK_MCP_SURFACE=1 is set, because the surface stopped being
  // part of this adapter's capability story:
  //
  //   * SONAR exports CCtrlSurface::PersistSurfaces (it writes ctrlsurface.dat)
  //     but no LoadSurfaces/RestoreSurfaces symbol exists in it at all. So the
  //     plugin is instantiated only at the instant the user presses OK in
  //     参数设置 > MIDI > 控制界面, and never restored — every fresh SONAR start
  //     needs that manual step again, which makes it flatly incompatible with a
  //     one-click deployment.
  //   * Even while loaded, the host object SONAR passes to Connect does NOT
  //     implement IDispatch, so SetTargetParam is unreachable and writes come
  //     back SURFACE_REFUSED. They never were a working mixer-write path.
  //   * Nothing needs them now. Volume and pan go through a .mid carrying
  //     CC7/CC10 (verified end to end); mute, rename and routing go through CAL;
  //     mute/solo/arm go through a real click on the track strip.
  //
  // Set CAKEWALK_MCP_SURFACE=1 to expose them for diagnostics and experiments.
  // Leaving them always-on would advertise 8 tools whose first action on a fresh
  // machine is to explain why they cannot work.
  if (process.env.CAKEWALK_MCP_SURFACE === '1') {
  server.tool(
    'cw_surface_status',
    'Report the control-surface bridge: whether the plugin DLL is loaded inside SONAR, whether '
    + 'SONAR has called Connect, and what is still needed. state can be not-installed, '
    + 'needs-user-setup, or ready. Reads only.',
    {},
    async () => { try { return textResult(await surfaceStatus()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_surface_diag',
    'The surface plugin\'s own log and counters, including the interface sweep of the host object '
    + 'SONAR passes to Connect. This is the measurement that establishes what the host object is; '
    + 'use it before trusting any surface write.',
    {},
    async () => { try { return textResult(await surfaceDiag()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_surface_params',
    'The parameter vocabulary the surface plugin accepts, as the plugin itself defines it, with '
    + 'each value\'s kind (bool, scalar, int).',
    {},
    async () => { try { return textResult(await surfaceParams()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_surface_set',
    'Set one mixer parameter through the control-surface plugin. WARNING, measured: this currently '
    + 'fails on this build with "host object does not implement IDispatch". It is exposed so the '
    + 'refusal and its reason are visible rather than hidden; use cw_edit_transpose / the CAL track '
    + 'programs / the accessibility path for real writes. Returns SURFACE_REFUSED with the reason.',
    {
      track: z.number().int().min(0).describe('Track index as the surface counts them (see cw_surface_diag)'),
      param: z.string().describe('Parameter name, uppercase, e.g. MUTE, SOLO, RECORD_ARM, INPUT, OUTPUT, BANK, PATCH'),
      value: z.union([z.number(), z.boolean()]).describe('For a bool parameter pass true/false; for a scalar 0..1 (PAN -1..1)'),
    },
    async ({ track, param, value }) => {
      try { return textResult(await surfaceSet(track, param, value)); } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_surface_midi_in',
    'MIDI that SONAR forwarded to the surface plugin, decoded. This is the working half of the '
    + 'surface bridge: once the surface is assigned the right INPUT port in Preferences, SONAR '
    + 'feeds it every message from that port. Requires that assignment — see cw_surface_status.',
    {},
    async () => { try { return textResult(await surfaceMidiIn()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_surface_dump',
    'Retired compatibility endpoint. Raw host-memory diagnostics are permanently disabled '
    + 'and return SURFACE_DIAGNOSTIC_DISABLED before connecting to the plugin.',
    {
      offset: z.number().int().min(0).max(0x2000).default(0),
      count: z.number().int().min(1).max(32).default(24),
    },
    async ({ offset, count }) => {
      try {
        const r = await surfaceDump({ offset, count });
        // BigInt does not JSON.stringify; render addresses as hex strings.
        return textResult({ ...r, base: '0x' + BigInt(r.base).toString(16),
          qwords: r.qwords.map(q => ({ offset: '0x' + q.offset.toString(16), address: q.address, value: '0x' + q.value.toString(16), module: q.module })) });
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_surface_read',
    'Retired compatibility endpoint. Arbitrary memory reads are permanently disabled; '
    + 'returns SURFACE_DIAGNOSTIC_DISABLED before any connection.',
    {
      addr: z.union([z.string(), z.number()]).describe('Absolute address, decimal or 0x-prefixed hex'),
      count: z.number().int().min(1).max(32).default(12),
    },
    async ({ addr, count }) => {
      try {
        const r = await surfaceRead(addr, { count });
        return textResult({ ...r, addr: '0x' + BigInt(r.addr).toString(16),
          qwords: r.qwords.map(q => ({ offset: '0x' + q.offset.toString(16), address: q.address, value: '0x' + q.value.toString(16), module: q.module })) });
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_surface_help',
    'How the control-surface bridge works, how SONAR discovers a surface, how to install it, and '
    + 'what it can and cannot do on this build.',
    {},
    async () => { try { return textResult(surfaceHelp()); } catch (e) { return errResult(e); } }
  );
  } // end CAKEWALK_MCP_SURFACE opt-in

  // ----- background jobs -----
  //
  // For operations that are slow for measured reasons (a track insert is ~19s,
  // a command survey ~15s per probe), so a caller can poll instead of blocking.

  server.tool(
    'cw_job',
    'Read one background job by id: state, elapsed time, progress trail, result or error. '
    + 'Poll this after a slow tool returns a job id.',
    { id: z.string().min(1).describe('Job id, as returned by a slow tool') },
    async ({ id }) => {
      try {
        const j = getJob(id);
        if (!j) {
          return textResult({
            ok: false,
            error: `no such job: ${id}`,
            hint: 'Job ids live in this adapter process only; a restart loses them.',
            recent: listJobs({ limit: 5 }),
          });
        }
        return textResult(j);
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_jobs',
    'List recent background jobs, newest first, without their payloads.',
    { limit: z.number().int().min(1).max(100).default(20) },
    async ({ limit }) => {
      try { return textResult({ ok: true, jobs: listJobs({ limit }) }); }
      catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_job_abandon',
    'Mark a background job abandoned so its result is discarded. This does NOT stop the work: a '
    + 'menu command already posted to SONAR cannot be recalled. It only stops this adapter from '
    + 'reporting the result.',
    { id: z.string().min(1) },
    async ({ id }) => { try { return textResult(abandonJob(id)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_job_clear',
    'Forget finished background jobs. Running jobs are kept so a caller does not lose track of them.',
    {},
    async () => { try { return textResult(clearJobs()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_job_help',
    'Why background jobs exist here, the states a job moves through, and the one thing the API '
    + 'deliberately cannot do (cancel work already sent to SONAR).',
    {},
    async () => { try { return textResult(jobHelp()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_cal_plan',
    'The exact plan for a CAL run: the script source, the dialog field to write, and how to prove '
    + 'the result from data. Pure — it writes no file and posts no command, so it is safe to call '
    + 'speculatively. Use cw_cal_run to actually do it.',
    {
      program: z.enum(Object.keys(CAL_PROGRAMS))
        .describe('Which generated program to plan. NOTES: setVelocity | scaleVelocity | '
          + 'addNotes | deleteNotes | transpose | setDuration | queryNotes | dumpNotes. '
          + 'TRACKS: renameTrack | setTrackMute | setTrackRouting.'),
      velocity: z.number().int().min(1).max(127).optional()
        .describe('For setVelocity: the value to set every note to.'),
      percent: z.number().min(1).max(1000).optional()
        .describe('For scaleVelocity / setDuration: the percentage to scale by.'),
      intervals: z.array(z.number().int().min(-127).max(127)).max(127).optional()
        .describe('For addNotes: semitone offsets to add above each source note, e.g. [12,16,19]. '
          + 'Negative values add below.'),
      minKey: z.number().int().min(0).max(127).optional()
        .describe('For deleteNotes: low end of the pitch range to remove (inclusive).'),
      maxKey: z.number().int().min(0).max(127).optional()
        .describe('For deleteNotes: high end of the pitch range to remove (inclusive).'),
      semitones: z.number().int().min(-127).max(127).optional()
        .describe('For transpose: the interval. SIGNED.'),
      trackIndex: z.number().int().min(0).max(255).optional()
        .describe('For the track programs: which track, 0-based. CAL counts project tracks from '
          + '0; an exported .mid puts the conductor first, so CAL track N is export track N+1.'),
      name: z.string().optional()
        .describe('For renameTrack: the new track name.'),
      mute: z.boolean().optional()
        .describe('For setTrackMute: true mutes, false un-mutes. TrackActive TRUE means AUDIBLE — '
          + 'the shipped script comments it as "Un-mute the track".'),
      channel: z.number().int().min(1).max(16).optional()
        .describe('For setTrackRouting: forced MIDI channel, 1..16.'),
      port: z.number().int().min(0).max(255).optional()
        .describe('For setTrackRouting: output port.'),
    },
    async (a) => {
      try {
        const { program, ...args } = a;
        return textResult(calPlan(program, args));
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_cal_run',
    'Write a CAL program into the folder SONAR reads, select everything, and open 处理 > 运行 CAL '
    + '程序 (0x806A). CAL needs no licence, so this is how notes get CREATED, DELETED or READ on a '
    + 'free build — the edit dialogs cover only transformation. This process cannot click, so it '
    + 'stops at the open dialog and reports the exact steps an accessibility runtime must take. '
    + 'The script ends with a modal pause that has to be dismissed, and CAL reports only a count — '
    + 'prove the effect by exporting and parsing.',
    {
      program: z.enum(Object.keys(CAL_PROGRAMS))
        .describe('Which generated program to run. queryNotes RENAMES the track as its output '
          + 'channel, so it needs allowRename.'),
      velocity: z.number().int().min(1).max(127).optional(),
      percent: z.number().min(1).max(1000).optional(),
      intervals: z.array(z.number().int().min(-127).max(127)).max(127).optional(),
      minKey: z.number().int().min(0).max(127).optional(),
      maxKey: z.number().int().min(0).max(127).optional(),
      semitones: z.number().int().min(-127).max(127).optional(),
      trackIndex: z.number().int().min(0).max(255).optional()
        .describe('For the track programs: which track, 0-based. CAL counts project tracks from '
          + '0; an exported .mid puts the conductor first, so CAL track N is export track N+1.'),
      name: z.string().optional()
        .describe('For renameTrack: the new track name. Quotes and backslashes are stripped, '
          + 'since CAL has no escape syntax in any shipped script.'),
      mute: z.boolean().optional()
        .describe('For setTrackMute: true mutes, false un-mutes. TrackActive TRUE means AUDIBLE — '
          + 'the shipped script comments it as "Un-mute the track".'),
      channel: z.number().int().min(1).max(16).optional()
        .describe('For setTrackRouting: forced MIDI channel, 1..16.'),
      port: z.number().int().min(0).max(255).optional()
        .describe('For setTrackRouting: output port.'),
      allowRename: z.boolean().default(false)
        .describe('queryNotes works by writing its summary into the track name, which modifies the '
          + 'project. Set this to accept that. For reading note data with no side effect, export to '
          + '.mid and use cw_read_midi_file instead.'),
      confirm: z.string().optional().describe('deleteNotes requires the exact token "deleteNotes".'),
      selectFirst: z.boolean().default(true)
        .describe('Post 编辑 > 选择 > 全部 first. The CAL body runs once per selected event, so '
          + 'without a selection these programs do nothing.'),
      backup: z.boolean().default(true)
        .describe('Write a .bak beside the script file before overwriting it.'),
    },
    async (a) => {
      try {
        const { program, allowRename, ...args } = a;
        if (program === 'queryNotes' && !allowRename) {
          const e = new Error(
            'queryNotes reports by RENAMING the track — CAL has no file-write channel, so the '
            + 'summary has to go into a property that can be read back. That modifies the project. '
            + 'Pass allowRename: true to accept it, or read notes with no side effect by exporting '
            + 'to .mid (0xA659) and calling cw_read_midi_file.'
          );
          e.code = 'NEEDS_RENAME_CONSENT';
          throw e;
        }
        return textResult(await openForScript(program, args,
          { selectFirst: args.selectFirst, backup: args.backup, confirm: args.confirm }));
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_check_quantize',
    'Judge a quantize from actual data instead of guessing. Give it the note ticks before the '
    + 'edit and the ticks the exported file now holds, and it computes what the settings should '
    + 'have produced and says whether they match and whether the notes landed on the grid. '
    + 'Pass `before` and `after` as tick arrays, or pass file paths to read them. The judgement '
    + 'is pure arithmetic, so it works without SONAR running.',
    {
      before: z.array(z.number()).optional().describe('Note start ticks before the edit'),
      after: z.array(z.number()).optional().describe('Note start ticks in the exported file'),
      beforeFile: z.string().optional().describe('Read `before` from this .mid instead'),
      afterFile: z.string().optional().describe('Read `after` from this .mid instead'),
      grid: z.string().default('16 分音符').describe('The grid the quantize targeted'),
      strength: z.number().min(0).max(100).default(100)
        .describe('The strength that was set. Must be the value actually written to the dialog, '
          + 'not the default — a stale 50 explains a half-moved result.'),
      swing: z.number().min(0).max(100).default(50)
        .describe('Swing that was set. 50 is straight; any other value means the verdict\'s '
          + 'on-grid test is straight-grid only and says so'),
    },
    async (a) => {
      try {
        const { readTicks } = await import('./note-edit.js');
        let before = a.before;
        let after = a.after;
        if (a.beforeFile) before = readTicks(a.beforeFile);
        if (a.afterFile) after = readTicks(a.afterFile);
        if (!before || !after) {
          const e = new Error('Need both sides: pass before/after arrays, or beforeFile/afterFile.');
          e.code = 'NEEDS_BOTH_SIDES';
          throw e;
        }
        const grid = gridTicks(a.grid);
        if (!grid) {
          const e = new Error(`Unknown grid '${a.grid}'. Known: ${Object.keys(
            (await import('./note-edit.js')).NOTE_VALUE_TICKS).join(', ')}`);
          e.code = 'UNKNOWN_GRID';
          throw e;
        }
        return textResult({ grid, gridTicks: grid, ...judgeQuantize({ before, after, grid, strength: a.strength, swing: a.swing }) });
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_quantize_dialog',
    'The 量化 dialog as measured: every field, its accessible label, which element kind to write '
    + 'to, the values it accepts, and the traps. Kept separate from the plan so a caller can see '
    + 'the raw measurement the plan is built from.',
    {},
    async () => { try { return textResult(QUANTIZE_DIALOG); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_no_effect_causes',
    'Why a command can report "nothing happened", with how to tell the three causes apart. Only '
    + 'one of them is a limit of this adapter.',
    {},
    async () => { try { return textResult({ causes: NO_EFFECT_CAUSES }); } catch (e) { return errResult(e); } }
  );

  // ----- document lifecycle -----

  server.tool(
    'cw_save_state',
    'Whether the open project has unsaved changes, in the terms that matter before closing or '
    + 'opening something else. Read from the title\'s modified marker.',
    {},
    async () => { try { return textResult(await saveState()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_project',
    'Run a document command: newProject | open | save | saveAs | close | exportAudio | importMidi | '
    + 'revert. The destructive ones (close, revert) refuse unless confirm is set to the command\'s '
    + 'own key, because they discard the session with no undo.',
    {
      command: z.enum(['newProject', 'open', 'save', 'saveAs', 'close', 'exportAudio', 'importMidi', 'revert']),
      confirm: z.string().optional()
        .describe("Must equal the command name for close/revert, e.g. confirm: 'close'"),
    },
    async ({ command, confirm }) => {
      try { return textResult(await projectCommand(command, { confirm })); } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_file_dialog',
    'How to drive the file dialog a document command opens: the element names, and why this one '
    + 'IS scriptable when SONAR\'s own controls are not (it is standard MFC, not drawn).',
    {},
    async () => {
      try {
        return textResult({
          dialog: FILE_DIALOG,
          commands: {
            newProject: PROJECT_COMMANDS.newProject,
            open: PROJECT_COMMANDS.open,
            saveAs: PROJECT_COMMANDS.saveAs,
          },
        });
      } catch (e) { return errResult(e); }
    }
  );

  // ----- transport and timing -----

  server.tool(
    'cw_transport_command',
    'Send a transport or timing command: play | stop | record | toggleLoop | setLoopSelection | '
    + 'metronomePlayback | metronomeRecord | showTempoView | showMeterView | insertTempoChange | '
    + 'insertMeterChange. Every one of these changes state WITHOUT opening a window, so this tool '
    + 'can post but not confirm — it returns what a computer-use runtime should look at.',
    { command: z.enum(['play', 'stop', 'record', 'toggleLoop', 'setLoopSelection',
      'metronomePlayback', 'metronomeRecord', 'showTempoView', 'showMeterView',
      'insertTempoChange', 'insertMeterChange']) },
    async ({ command }) => { try { return textResult(await transportCommand(command)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_timing',
    'How to set and read tempo and time signature. Writing them into a .mid and importing is the '
    + 'reliable route; inserting a change at the now-time is a different operation.',
    {},
    async () => { try { return textResult({ recipes: TEMPO_RECIPES, state: await timingState() }); } catch (e) { return errResult(e); } }
  );

  // ----- evidence and verification -----

  server.tool(
    'cw_command_evidence',
    'Which commands have been confirmed to work, which are unconfirmed and why. Unconfirmed does '
    + 'NOT mean broken: a toggle or a transport action never opens a window, so a window diff '
    + 'reports nothing. This says which witness would settle each one.',
    {},
    async () => { try { return textResult(evidenceSummary()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_run_command_classified',
    'Run a menu command and report what this process could and could not establish, instead of '
    + 'claiming success from "nothing errored". Returns status confirmed | did-nothing | '
    + 'unconfirmed, with the evidence class behind it.',
    {
      cmdId: z.number().int().min(0),
      keepOverlays: z.boolean().default(false),
      confirm: z.string().optional().describe('Exact command name required for a destructive command.'),
    },
    async ({ cmdId, keepOverlays, confirm }) => {
      try { return textResult(await runAndClassify(cmdId, { keepOverlays, confirm })); } catch (e) { return errResult(e); }
    }
  );

  // ----- MIDI file: the data-level interface -----
  // SONAR's accessibility tree has no note, clip or event elements — verified
  // across a live project. On a build with no CakeScript transport a .mid file
  // is the only way to move notes in or out, and CC7/CC10 in the file become
  // track volume and pan on import.

  server.tool(
    'cw_read_midi_file',
    'Parse a Standard MIDI File: per-track name, channels, note count, and any CC7/CC10 with the '
    + 'pan position spelled out. Use it to check what a file carries before importing it, or to '
    + 'read back a file SONAR exported.',
    {
      path: z.string().describe('Absolute path to a .mid file'),
      includeNotes: z.boolean().default(false).describe('Include the full note list (can be long)'),
    },
    async ({ path, includeNotes }) => {
      try {
        const d = midiFile.describe(path);
        if (includeNotes) d.notes = midiFile.read(path).tracks.map((t) => t.notes);
        return textResult(d);
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_write_midi_file',
    'Generate a Standard MIDI File (format 1) from note and CC events. Each track needs a MIDI '
    + 'channel; CC7/CC10 written at tick 0 become that track\'s initial volume and pan when SONAR '
    + 'imports the file. This is the reliable way to set mixer values and place notes, because the '
    + 'in-app controls are read-only through automation on this build.',
    {
      path: z.string().describe('Where to write the .mid'),
      bpm: z.number().min(20).max(300).default(120),
      overwrite: z.boolean().default(false)
        .describe('Replace an existing file. Without this, writing over a path that already exists is refused'),
      tracks: z.array(z.object({
        name: z.string().optional(),
        channel: z.number().int().min(1).max(16).describe('1-based; SONAR routes a CC to the track carrying this channel'),
        program: z.number().int().min(0).max(127).optional().describe('GM program number'),
        volumeCC: z.number().int().min(0).max(127).optional(),
        panCC: z.number().int().min(0).max(127).optional().describe('0 hard left, 64 centre, 127 hard right'),
        pan: z.number().min(-1).max(1).optional().describe('Alternative to panCC: -1..+1'),
        notes: z.array(z.object({
          tick: z.number().int().min(0),
          pitch: z.number().int().min(0).max(127),
          velocity: z.number().int().min(1).max(127).default(100),
          duration: z.number().int().min(1),
        })).default([]),
        /*
         * Raw bytes, for callers that need events `notes` cannot express — the
         * writer's channel-mismatch guard fires on exactly this shape, and without
         * it that guard was unreachable through MCP: zod strips unknown keys, so an
         * `events` field sent by a client was silently dropped and the track came
         * out empty. Channel bytes are 0-based here (0x90 = channel 1), matching
         * what lib/midi-file.js exposes.
         */
        events: z.array(z.object({
          tick: z.number().int().min(0),
          bytes: z.array(z.number().int().min(0).max(255)).min(1),
        })).optional()
          .describe('Raw MIDI bytes, for events the notes field cannot express. Use with channel '
            + 'when you need the writer to check for a channel mismatch.'),
      })).min(1).max(32),
    },
    async ({ path, bpm, overwrite, tracks }) => {
      try {
        // This tool writes a file, so it is the one place an agent (or a prompt
        // that hijacks one) can destroy data. Two cheap guards, both measured:
        // without them `path: C:\Users\x\Documents\thesis.docx` was silently
        // replaced with MIDI bytes, and any existing .mid was overwritten.
        const raw = String(path);
        if (!/\.(mid|midi)$/i.test(raw)) {
          const e = new Error(`refusing to write '${path}': the path must end in .mid or .midi`);
          e.code = 'BAD_EXTENSION';
          throw e;
        }
        // 'name.mid' is not enough. NTFS alternate data streams let
        // `victim.docx:evil.mid` pass the suffix check while the bytes land inside
        // an existing .docx, and a device/UNC path is not a local file at all.
        const afterDrive = /^[A-Za-z]:/.test(raw) ? raw.slice(2) : raw;
        if (afterDrive.includes(':')) {
          const e = new Error(`refusing to write '${path}': a colon after the drive letter means an NTFS stream or a device path`);
          e.code = 'BAD_PATH';
          throw e;
        }
        const twoBackslashes = String.fromCharCode(92) + String.fromCharCode(92);
        if (raw.startsWith('//') || raw.startsWith(twoBackslashes)) {
          const e = new Error(`refusing to write '${path}': UNC paths are not supported by this tool (write locally, then copy)`);
          e.code = 'BAD_PATH';
          throw e;
        }
        if (!overwrite && existsSync(path)) {
          const e = new Error(`refusing to overwrite existing file '${path}'. Pass overwrite: true if that is intended.`);
          e.code = 'FILE_EXISTS';
          throw e;
        }
        const built = tracks.map((t) => {
          // Channel is 1-based throughout: notes use it directly, and
          // buildTrack converts to the wire nibble.
          const noteEvents = t.notes.flatMap((n) => ([
            { tick: n.tick, bytes: midiFile.on(t.channel - 1, n.pitch, n.velocity) },
            { tick: n.tick + n.duration, bytes: midiFile.off(t.channel - 1, n.pitch) },
          ]));
          const events = [...noteEvents, ...(t.events || [])];
          const panVal = t.panCC !== undefined ? t.panCC
            : (t.pan !== undefined ? midiFile.panCC(t.pan) : undefined);
          return {
            name: t.name,
            channel: t.channel,            // 1-based; buildTrack converts
            program: t.program,
            mix: (t.volumeCC !== undefined || panVal !== undefined)
              ? { volume: t.volumeCC, pan: panVal }
              : undefined,
            events,
          };
        });
        return textResult(midiFile.write(path, { bpm, tracks: built, overwrite }));
      } catch (e) { return errResult(e); }
    }
  );

  // ----- mixer control (the path that works) -----

  server.tool(
    'cw_set_pan',
    'Set a track\'s pan through the live MIDI cable (CC10). This is the path that actually works: '
    + 'the track strips\' pan slider is read-only through accessibility on this build. `channel` is '
    + 'the MIDI channel the track listens on, not its position — read it from the strip\'s '
    + '"MIDI 通道 on Track N" value.',
    {
      channel: z.number().int().min(1).max(16).default(1),
      position: z.number().min(-1).max(1).optional().describe('-1 hard left, 0 centre, +1 hard right'),
      value: z.number().int().min(0).max(127).optional().describe('Raw CC10 value; overrides position'),
    },
    async (a) => { try {
      // An empty call used to send CC10=64 (recentre). Requiring one of the two
      // fields turns a silent no-op into an explicit mistake.
      if (a.position === undefined && a.value === undefined) {
        const e = new Error('pass position (-1..1) or value (0..127); an empty call would recentre the channel');
        e.code = 'MISSING_ARGUMENT';
        throw e;
      }
      return textResult(await mixer.setPan(a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_set_volume',
    'Set a track\'s volume through the live MIDI cable (CC7). `level` is 0.0-1.0, or pass a raw '
    + 'CC value.',
    {
      channel: z.number().int().min(1).max(16).default(1),
      level: z.number().min(0).max(1).optional(),
      value: z.number().int().min(0).max(127).optional(),
    },
    async (a) => { try {
      // Same trap as cw_set_pan: with both fields optional, {} used to mean
      // level 0 — i.e. it muted the channel while reporting ok:true.
      if (a.level === undefined && a.value === undefined) {
        const e = new Error('pass level (0.0-1.0) or value (0-127); an empty call would send CC7=0 and mute the channel');
        e.code = 'MISSING_ARGUMENT';
        throw e;
      }
      return textResult(await mixer.setVolume(a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_apply_mix',
    'Set pan and volume for several channels in one round trip. `mix` is '
    + '[{ channel, pan?, volume? }] with pan in -1..1 and volume in 0..1.',
    {
      mix: z.array(z.object({
        channel: z.number().int().min(1).max(16),
        pan: z.number().min(-1).max(1).optional(),
        volume: z.number().min(0).max(1).optional(),
        panCC: z.number().int().min(0).max(127).optional(),
        volumeCC: z.number().int().min(0).max(127).optional(),
      })).min(1).max(64),
    },
    async ({ mix }) => { try { return textResult(await mixer.applyMix(mix)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_mixer_targets',
    'What a live MIDI mixer message can affect right now, and why. A CC reaches SONAR but only '
    + 'applies where a track is listening (armed, channel-assigned, or bound to ACT) — without a '
    + 'destination it is delivered and dropped, which is invisible unless you check.',
    {},
    async () => { try { return textResult({ ...(await mixer.mixerTargets()), support: mixer.MIXER_WRITE_SUPPORT }); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_mixer_support',
    'What can and cannot set a track\'s volume or pan on this build, measured, with the survey '
    + 'behind it. Accessibility reads mixer state but does not accept it; MIDI writes do.',
    {},
    async () => { try { return textResult(mixer.MIXER_WRITE_SUPPORT); } catch (e) { return errResult(e); } }
  );

  // ----- benchmark -----

  server.tool(
    'cw_benchmark',
    'Measure what this adapter can actually do against the running SONAR, and how fast: every '
    + 'capability grouped by transport, with the confirmation method for each result. Use it after '
    + 'a SONAR update to re-establish the boundaries. '
    + 'Measured: a full sweep takes 70s+, and not only because of the plugin scan — the write cases '
    + 'post a command and then wait for the UI to settle, and four of them account for ~55s of it. '
    + 'So the default answers from the read half (a few seconds) and every expensive stage is '
    + 'opt-in and named in `skipped`. Pass full: true for everything. The write stages can start '
    + 'playback and send MIDI to the selected destination; they do not insert tracks or buses.',
    {
      full: z.boolean().default(false)
        .describe('Run every stage: the write cases and the plugin inventory scan. Takes 70s+. The '
          + 'default read-only sweep answers in a few seconds and says which stages it skipped.'),
      includePluginScan: z.boolean().optional()
        .describe('Explicit override for the plugin-inventory stage; implies nothing about writes.'),
      includeMidiSend: z.boolean().default(true)
        .describe('Only meaningful when the write cases run.'),
      includeWrites: z.boolean().default(false)
        .describe('Run the cases that post a command and wait for the UI. ~55s of the total.'),
    },
    async (a) => {
      try {
        const full = a.full === true;
        const opts = {
          includeMidiSend: a.includeMidiSend,
          includePluginScan: a.includePluginScan ?? full,
          includeWrites: a.includeWrites || full,
        };
        return textResult(await runBenchmark(opts));
      } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_latency',
    'Per-operation latency profile: bridge round trips, menu commands, MIDI sends, plugin reads. '
    + 'The plugin-read stage is the slow one, so it is skipped by default for the same reason '
    + 'cw_benchmark is — a bare call must return, not time out.',
    {
      includePluginReads: z.boolean().default(false)
        .describe('Include the plugin-inventory stage. Adds 10s+; skipped by default.'),
    },
    async (a) => {
      try { return textResult(await latencyProfile(a)); } catch (e) { return errResult(e); }
    }
  );

  // ----- project state (computer-use assisted) -----
  // SONAR 2026.10 exposes no project text through Win32, UIA or MSAA — verified,
  // see lib/project-state.js. On builds without CakeScript the only reader is a
  // computer-use runtime, so these tools hand out a probe plan and take the
  // observation back instead of pretending to read it.

  server.tool(
    'cw_probe_state',
    'Get a plan for reading project state on this build. Lists which SONAR surface carries each '
    + 'fact (track list, mixer values, notes) and the steps to capture it. Use when cw_get_* '
    + 'tools report CAKESCRIPT_UNAVAILABLE.',
    {
      topic: z.enum(['overview', 'tracks', 'mixer', 'notes', 'selection', 'all'])
        .default('overview')
        .describe('overview: project/tempo/tracks. tracks: names+states. mixer: fader and pan values. '
          + 'notes: note list (needs the Event List view). all: everything worth reading.'),
    },
    async ({ topic }) => {
      try { return textResult(probePlan(topic)); } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_report_state',
    'Send back what a computer-use agent observed, so later calls reuse it instead of re-probing. '
    + 'Shape the state like the CakeScript tools did: { tracks: [{index,name,type,volume,pan,mute,'
    + 'solo,arm,clips}], notes: [{track,pitch,velocity,time,duration}], now, tempo, loop, project }.',
    {
      topic: z.enum(['overview', 'tracks', 'mixer', 'notes', 'selection', 'all']).default('overview'),
      state: z.record(z.any()).describe('The observation, as JSON'),
      source: z.string().default('computer-use'),
      note: z.string().optional().describe('Anything that limits confidence in the reading'),
    },
    async (a) => { try { return textResult(reportState(a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_get_state',
    'Read the most recent observation for a topic. Reports staleness and why it is empty when '
    + 'nothing has been observed yet.',
    {
      topic: z.enum(['overview', 'tracks', 'mixer', 'notes', 'selection', 'all']).default('overview'),
    },
    async ({ topic }) => { try { return textResult(getState(topic)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_list_state',
    'List which project-state topics have been observed, and when.',
    {},
    async () => { try { return textResult(listState()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_surfaces',
    'Every SONAR UI surface that carries project state, and what can be read from each. '
    + 'Reference for writing a probe.',
    {},
    async () => { try { return textResult({ surfaces: SURFACES }); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_midi_config',
    'Read SONAR\'s MIDI port configuration (TTSSEQ.INI): which ports SONAR has enabled as '
    + 'inputs, outputs and echo. Use this to verify the receive side, which a send cannot confirm.',
    {},
    async () => { try { return textResult(midiConfigSummary()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_enable_midi_port',
    'Enable a MIDI port in SONAR by writing TTSSEQ.INI, so the MIDI transport reaches SONAR '
    + 'without touching the UI. Idempotent. SONAR applies it at startup or when its MIDI Devices '
    + 'dialog is applied — not live in the current session.',
    {
      port: z.string().min(1).describe('Port name exactly as Windows reports it, e.g. "Studio One AI Notes"'),
      section: z.enum(['input', 'output', 'echo']).default('input'),
      backup: z.boolean().default(true).describe('Write a .bak beside the file before changing it'),
    },
    async (a) => { try { return textResult(enablePort(a.port, a)); } catch (e) { return errResult(e); } }
  );

  // ----- real-time MIDI transport (works without CakeScript) -----

  server.tool(
    'cw_midi_status',
    'Report the real-time MIDI transport: available ports, which one will be used, and the '
    + 'one-time step needed in SONAR (Preferences > MIDI > Inputs) to receive it.',
    {},
    async () => { try { return textResult(await live.liveStatus()); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_midi_devices',
    'List every MIDI device Windows reports, in and out.',
    {},
    async () => { try { return textResult({ devices: await live.devices() }); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_midi_note',
    'Play a note on the live MIDI port. Use this to audition or to write into a record-armed '
    + 'track. millisecond latency; no CakeScript involved.',
    {
      pitch: z.number().int().min(0).max(127).describe('MIDI note number, 60 = middle C'),
      velocity: z.number().int().min(1).max(127).default(100),
      durationMs: z.number().int().min(1).max(60000).default(250),
      channel: z.number().int().min(1).max(16).default(1),
    },
    async (a) => { try { return textResult(await live.playNote(a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_midi_chord',
    'Play several notes at once on the live MIDI port, released together.',
    {
      pitches: z.array(z.number().int().min(0).max(127)).min(1).max(32),
      velocity: z.number().int().min(1).max(127).default(100),
      durationMs: z.number().int().min(1).max(60000).default(500),
      channel: z.number().int().min(1).max(16).default(1),
    },
    async (a) => { try { return textResult(await live.playChord(a)); } catch (e) { return errResult(e); } }
  );

  server.tool(
    'cw_midi_cc',
    'Send a MIDI control change on the live port. cc 7 = channel volume, 10 = pan.',
    {
      controller: z.number().int().min(0).max(127),
      value: z.number().int().min(0).max(127),
      channel: z.number().int().min(1).max(16).default(1),
    },
    async ({ controller, value, channel }) => {
      try { return textResult(await live.sendCC(channel, controller, value)); } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_midi_send',
    'Send a batch of raw MIDI messages in one round trip. Each message is [status, data1, data2]. '
    + 'Use this to lay down a phrase cheaply; pass channel to rewrite the low nibble of each status byte.',
    {
      messages: z.array(z.array(z.number().int().min(0).max(255)).min(2).max(3)).min(1).max(2048),
      channel: z.number().int().min(1).max(16).optional(),
    },
    async ({ messages, channel }) => {
      try { return textResult(await live.sendMessages(messages, { channel })); } catch (e) { return errResult(e); }
    }
  );

  server.tool(
    'cw_midi_panic',
    'Send all-notes-off and reset controllers on every channel, then reset the port.',
    {},
    async () => { try { return textResult(await live.allNotesOff()); } catch (e) { return errResult(e); } }
  );

  // ----- track-level (CakeScript transport) -----
  //
  // Every tool in this first group has exactly ONE implementation: a CakeScript
  // template. On a build where T1 cannot be dispatched they fail 100% of the
  // time, so each description now says so up front and each error names the
  // replacement. Advertising a working tool that can never work is worse than
  // not having it: the caller burns a round trip and learns nothing.

  server.tool('cw_list_tracks', 'List all tracks in the active SONAR project. '
    + 'NEEDS CakeScript (T1), which this SONAR build cannot dispatch — on this build use the '
    + 'export route instead: cw_run_command 0xA659 (文件 > 导出 > 标准 MIDI 文件), then '
    + 'cw_read_midi_file on the result.', {}, async () => {
    try { return textResult(await runTemplate('listTracks')); }
    catch (e) { return errResult(t1Only('cw_run_command 0xA659 to export a .mid, then cw_read_midi_file — '
      + 'it reports every track name. For what each strip shows without a file, cw_get_track_control '
      + 'reads one control at a time (音量 / 声像 / 手动静音 / 独奏 / 录制).')(e)); }
  });

  server.tool('cw_get_track', 'Get one track\'s properties. '
    + 'NEEDS CakeScript (T1), which this SONAR build cannot dispatch. '
    + 'cw_get_track_control reads a single strip control and works without it.',
    {
    index: z.number().int().min(1).describe('1-based track index'),
  }, async ({ index }) => {
    try { return textResult(await runTemplate('getTrack', [index])); }
    catch (e) { return errResult(t1Only('cw_get_track_control index=' + index + ' label=音量 (or 声像 / '
      + '手动静音 / 独奏 / 录制) — it reads the strip through accessibility and needs no CakeScript.')(e)); }
  });

  server.tool('cw_set_track_volume', 'Set a track\'s volume (0.0 to 1.0+; 1.0 = unity). '
    + 'NEEDS CakeScript (T1), which this SONAR build cannot dispatch, and there is no drop-in '
    + 'replacement: SONAR\'s accessibility actions are inert on the fader (measured) and CAL has no '
    + 'volume builtin. cw_set_volume sends live CC7 on a MIDI channel instead — it reaches the engine '
    + 'but only moves a track that is listening to that channel. See cw_mixer_support for the survey.',
    { index: z.number().int().min(1), volume: z.number().min(0).max(4) },
    async ({ index, volume }) => { try { return textResult(await runTemplate('setTrackVolume', [index, volume])); } catch (e) { return errResult(t1Only('cw_set_volume (live CC7 on a MIDI channel) or '
      + 'cw_apply_mix for several channels at once — see cw_mixer_support for what each path can and '
      + 'cannot do. There is no way to set an arbitrary track fader on this build.')(e)); } });

  server.tool('cw_set_track_pan', 'Set a track\'s stereo pan (-1.0 = full left, 0 = centre, +1.0 = full right). '
    + 'NEEDS CakeScript (T1), which this SONAR build cannot dispatch — same limits as '
    + 'cw_set_track_volume. cw_set_pan sends live CC10 on a MIDI channel instead.',
    { index: z.number().int().min(1), pan: z.number().min(-1).max(1) },
    async ({ index, pan }) => { try { return textResult(await runTemplate('setTrackPan', [index, pan])); } catch (e) { return errResult(t1Only('cw_set_pan (live CC10 on a MIDI channel), or bake '
      + 'panCC into a .mid with cw_write_midi_file and import it. No direct fader write exists here.')(e)); } });

  server.tool('cw_set_track_mute', 'Mute or unmute a track. Works by driving the track strip\'s own '
    + '静音 button (a real click — SONAR\'s accessibility actions are inert), and reports `verified` '
    + 'from the value read back. Needs a project open and the track visible in the Track view.',
    { index: z.number().int().min(1), mute: z.boolean() },
    async ({ index, mute }) => {
      try { return textResult(await setTrackControl('mute', index, mute)); }
      catch (e) {
        try { return textResult(await runTemplate('setTrackMute', [index, mute])); }
        catch (e2) { return errResult(withBothErrors(e, e2)); }
      }
    });

  server.tool('cw_set_track_solo', 'Solo or unsolo a track, through the track strip\'s 独奏 button. '
    + 'Reports `verified` from the value read back. Needs a project open and the track visible.',
    { index: z.number().int().min(1), solo: z.boolean() },
    async ({ index, solo }) => {
      try { return textResult(await setTrackControl('solo', index, solo)); }
      catch (e) {
        try { return textResult(await runTemplate('setTrackSolo', [index, solo])); }
        catch (e2) { return errResult(withBothErrors(e, e2)); }
      }
    });

  server.tool('cw_set_track_arm', 'Arm or unarm a track for recording, through the track strip\'s '
    + '录制 button. Reports `verified` from the value read back. Needs a project open and the track '
    + 'visible.',
    { index: z.number().int().min(1), arm: z.boolean() },
    async ({ index, arm }) => {
      try { return textResult(await setTrackControl('arm', index, arm)); }
      catch (e) {
        try { return textResult(await runTemplate('setTrackArm', [index, arm])); }
        catch (e2) { return errResult(withBothErrors(e, e2)); }
      }
    });

  server.tool('cw_get_track_control', 'Read one track-strip control as SONAR currently shows it — '
    + 'any label, e.g. 音量, 声像, 手动静音, 独奏, 录制, 输入, 输出, 存档. Reading is accurate; writing '
    + 'is only available for the three toggles (cw_set_track_mute / solo / arm).',
    { index: z.number().int().min(1), label: z.string().min(1).max(32) },
    async ({ index, label }) => { try { return textResult(await readTrackControl(label, index)); } catch (e) { return errResult(e); } });

  server.tool('cw_list_track_templates', 'List the .cwx track templates SONAR has available, with '
    + 'their category. A template is a whole pre-built strip — instrument, FX chain, sends, routing — '
    + 'and inserting one is the verifiable way this adapter puts a plug-in chain into a project.',
    { filter: z.string().optional().describe('Only templates whose name or category contains this') },
    async ({ filter }) => {
      try {
        const all = listTrackTemplates();
        const list = filter
          ? all.filter(t => (t.name + ' ' + t.category).toLowerCase().includes(filter.toLowerCase()))
          : all;
        return textResult({ count: list.length, total: all.length,
                            templates: list.map(t => ({ name: t.name, category: t.category, file: t.file })) });
      } catch (e) { return errResult(e); }
    });

  server.tool('cw_insert_track_template', 'Insert a track template into the project by name (or full '
    + '.cwx path), then confirm it by finding the new track in the strip accessibility tree. Needs a '
    + 'project open. Use cw_list_track_templates to see what is available.',
    { name: z.string().min(1).describe('Template name, e.g. "Bass Rock Rhythm", or a full .cwx path') },
    async ({ name }) => { try { return textResult(await insertTrackTemplate(name)); } catch (e) { return errResult(e); } });

  server.tool('cw_set_track_name', 'Rename a track by editing its strip\'s name field (double-click, '
    + 'paste, Enter), and report `verified` from the name read back. Handles Chinese, unlike the '
    + 'CakeScript route this replaces. Needs a project open and the track visible in the Track view.',
    { index: z.number().int().min(1), name: z.string().min(1).max(128) },
    async ({ index, name }) => {
      try { return textResult(await renameTrack(index, name)); }
      catch (e) {
        try { return textResult(await runTemplate('setTrackName', [index, name])); }
        catch (e2) { return errResult(withBothErrors(e, e2)); }
      }
    });

  // ----- notes -----

  server.tool('cw_get_clips', 'List clips on a track. '
    + 'NEEDS CakeScript (T1), which this SONAR build cannot dispatch.',
    { index: z.number().int().min(1) },
    async ({ index }) => { try { return textResult(await runTemplate('getClips', [index])); } catch (e) { return errResult(t1Only('export the project (cw_run_command 0xA659, 文件 > 导出 > 标准 MIDI 文件) '
      + 'and parse it with cw_read_midi_file — it reports each track\'s clips as note/CC groups. '
      + 'cw_cal_help queryNotes summarises a selection in place, at the cost of renaming the track.')(e)); } });

  server.tool('cw_get_notes', 'Get the notes of a clip on a track (default clip 1). '
    + 'NEEDS CakeScript (T1), which this SONAR build cannot dispatch. The export route is the '
    + 'verified way to read note data on this build.',
    { index: z.number().int().min(1), clipIndex: z.number().int().min(1).default(1) },
    async ({ index, clipIndex }) => { try { return textResult(await runTemplate('getNotes', [index, clipIndex])); } catch (e) { return errResult(t1Only('cw_run_command 0xA659 (文件 > 导出 > 标准 MIDI 文件), then '
      + 'cw_read_midi_file with includeNotes=true — tick/pitch/velocity/duration per note. CAL cannot '
      + 'return a note list as text (measured: the string does not survive the per-event walk).')(e)); } });

  // ----- transport -----

  server.tool('cw_transport', 'Send a transport command (play | stop | record | pause). Tries '
    + 'CakeScript first and falls back to SONAR\'s own menu commands, so it works on builds where '
    + 'T1 cannot be dispatched.',
    { cmd: z.enum(['play', 'stop', 'record', 'pause']) },
    async ({ cmd }) => {
      // T1 is unavailable on this build, so the old flow paid an 8 s failing call
      // before falling back. Ask first; only try T1 when the transport exists.
      let t1 = false;
      try { t1 = (await capabilities()).transports[TRANSPORTS.WINDOW_MESSAGE].available; } catch (_) {}
      if (!t1 && cmd !== 'pause') {
        try { return textResult(await transportCommand(cmd)); }
        catch (e2) {
          const e1 = new Error('CakeScript is unavailable on this build (no AI-Assistant window).');
          e1.code = 'CAKESCRIPT_UNAVAILABLE';
          const both = withBothErrors(e2, e1);
          both.code = e2.code || both.code;
          return errResult(both);
        }
      }
      try { return textResult(await runTemplate('transport', [cmd])); }
      catch (e) {
        // The fallback makes this tool work rather than merely failing better:
        // 播放/停止, 停止 and 录制 are plain menu commands (0x801D/0x801F/0x801C)
        // and need no scripting engine at all.
        //
        // 'pause' is deliberately NOT mapped. The only nearby id is 0x801D, which
        // is a play/stop TOGGLE — sending it on a stopped transport would start
        // playback, so quietly "supporting" pause would be worse than saying it
        // is unavailable.
        if (!isT1Blocker(e) || cmd === 'pause') {
          return errResult(t1Only('cw_transport_command, whose play | stop | record are menu commands. '
            + 'There is no separate pause: the transport is driven by 播放/停止 (0x801D, a toggle) and '
            + '停止 (0x801F), so use stop.')(e));
        }
        try { return textResult(await transportCommand(cmd)); }
        catch (e2) {
          // The fallback DID run, so leading with the T1 blocker would be wrong —
          // it would claim no fallback exists while the real reason (no project
          // open, say) sits in the second error. Put the useful failure first and
          // keep the T1 blocker as the parenthetical, which is what withBothErrors
          // is for.
          const both = withBothErrors(e2, e);
          // ...and let the code follow the leading error. withBothErrors prefers
          // whichever error carries transport detail, which here is the blocker —
          // so the caller would see CAKESCRIPT_UNAVAILABLE and conclude no path
          // exists, when in fact opening a project makes this call succeed.
          both.code = e2.code || both.code;
          return errResult(both);
        }
      }
    });

  server.tool('cw_locate', 'Move the now-time to a Bars/Beats position, e.g. "1:01:000". '
    + 'NEEDS CakeScript (T1), which this SONAR build cannot dispatch, and no menu command performs '
    + 'an absolute jump: cw_navigate moves by whole measures (goToNextMeasure / goToPrevMeasure) '
    + 'only. cw_convert turns a position into ticks if you need the number itself.',
    { time: z.string() },
    async ({ time }) => { try { return textResult(await runTemplate('locate', [time])); } catch (e) { return errResult(t1Only('cw_navigate with goToNextMeasure / goToPrevMeasure to step relative to the '
      + 'current position — the absolute position ' + time + ' cannot be set on this build. To verify '
      + 'where the now-time ended up, use a computer-use runtime against the transport bar.')(e)); } });

  return server;
}

export async function runServer() {
  const server = buildServer();
  // A single message above the SDK's 10 MB default makes the transport close
  // itself, which used to look like a clean exit. Raise the ceiling (a large
  // cw_write_midi_file spec is legitimate) and remember WHY it closed.
  const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MAX_MESSAGE_BYTES,
  });
  let transportErrored = false;
  // The SDK drops a malformed message (bad JSON, params:null) by calling the
  // protocol's error hook. Unset, that hook is a no-op, so the client waits
  // forever for a reply that will never come. Answer with a JSON-RPC error
  // instead — id null is what the spec uses for errors it cannot attribute.
  server.server.onerror = (err) => {
    transportErrored = true;
    // JSON-RPC has separate codes for "could not parse the JSON" (-32700) and
    // "parsed, but not a valid request" (-32600). The single -32600 made a
    // client unable to tell a corrupt frame from a bad method.
    // Node phrasing varies by version, so match the family.
    const why = String((err && err.message) || err);
    const isParse = (err && err.name === 'SyntaxError')
      || /JSON at position|Unexpected token|Unexpected end of JSON|Expected property name/i.test(why)
      || /SyntaxError/i.test(why);
    try {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: isParse ? -32700 : -32600,
          message: (isParse ? 'parse error: ' : 'invalid request: ') + why,
        },
      }) + '\n');
    } catch (_) { /* the pipe may already be gone */ }
  };
  await server.connect(transport);
  // A client that closes stdin is done with us. StdioServerTransport only calls
  // onclose from its own close(), which nothing invokes on EOF, so listen for
  // 'end' directly. Without this the process (and its PowerShell/MIDI shims)
  // stayed alive forever after the client exited.
  // A clean client disconnect exits 0; a transport that closed itself because a
  // message was unreadable exits 1, so the caller can tell the two apart.
  transport.onclose = () => process.exit(transportErrored ? 1 : 0);
  process.stdin.on('end', () => {
    // Drain a final message that arrived without a trailing newline before
    // leaving; the old handler exited with it still in the buffer.
    try { transport.processReadBuffer(); } catch (_) { /* nothing buffered */ }
    setTimeout(() => process.exit(0), 50);
  });
  process.stderr.write('[cakewalk-mcp] connected to stdio\n');
}
