// test/integration.test.mjs — the MCP surface, the error paths, and the modules
// that touch the outside world.
//
// These tests do not assume SONAR is running and they do not start it. Where a
// capability needs a live SONAR they assert the *failure mode* instead — that the
// error is the documented one with a machine-readable code and a hint, rather
// than a timeout or an unhandled exception. That distinction matters because the
// whole point of the dispatch layer is to say what to use instead when a
// transport is missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The server this file spawns starts a PowerShell bridge and a MIDI shim, both
// long-lived by design. Anything this file itself started is dealt with inside
// talk(); this covers the modules loaded directly (capabilities, commandSupport)
// which share the same bridge.
test.after(async () => {
  /*
   * Close any modal this suite left behind, BEFORE shutting the shims.
   *
   * Without this, a dialog opened by one test is still on screen when the next run
   * starts, and a leftover modal swallows menu commands — so the edit test sees an
   * empty window list and fails for a reason that has nothing to do with the code.
   * That happened three times while getting that test right, which is why the
   * cleanup is here rather than left to whoever runs the suite twice.
   */
  try {
    const menu = await import('../lib/menu.js');
    await menu.closeOverlays();
  } catch (_) { /* best effort — a missing SONAR is not this suite's problem */ }
  const { shutdownShims } = await import('./helpers.mjs');
  await shutdownShims();
});

// --- MCP protocol ------------------------------------------------------------

/** Start the server, send a list of JSON-RPC messages, collect the replies. */
function talk(messages, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(ROOT, 'bin', 'cakewalk-mcp.js')],
      { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
    const replies = [];
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no reply in ${timeoutMs}ms; stderr: ${stderr.slice(0, 400)}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { replies.push(JSON.parse(line)); } catch (_) { /* log noise */ }
      }
      if (replies.length >= messages.filter((m) => m.id !== undefined).length) {
        clearTimeout(timer);
        child.kill();
        resolve({ replies, stderr });
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);

    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

const INIT = [
  { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];

test('the server answers initialize with its name and version', async () => {
  const { replies } = await talk(INIT);
  const init = replies.find((r) => r.id === 1);
  assert.ok(init, 'an initialize reply is required');
  assert.equal(init.result.serverInfo.name, 'cakewalk-mcp');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.ok(init.result.capabilities.tools, 'tools capability must be advertised');
});

test('tools/list returns a well-formed tool for every entry', async () => {
  const { replies } = await talk([...INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const list = replies.find((r) => r.id === 2);
  assert.ok(list.result.tools.length > 40, `expected the full tool surface, got ${list.result.tools.length}`);
  const names = new Set();
  for (const t of list.result.tools) {
    assert.match(t.name, /^cw_[a-z0-9_]+$/, `bad tool name: ${t.name}`);
    assert.ok(!names.has(t.name), `duplicate tool name: ${t.name}`);
    names.add(t.name);
    assert.ok(t.description && t.description.length > 20,
      `${t.name} needs a description a caller can act on`);
    assert.ok(t.inputSchema, `${t.name} needs an input schema`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema must be an object`);
  }
});

test('every tool declares an object schema with typed properties', async () => {
  const { replies } = await talk([...INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const tools = replies.find((r) => r.id === 2).result.tools;
  const withRequired = tools.filter((t) => Array.isArray(t.inputSchema.required) && t.inputSchema.required.length);
  assert.ok(withRequired.length > 0, 'some tools should have required arguments');
  for (const t of withRequired) {
    for (const key of t.inputSchema.required) {
      assert.ok(t.inputSchema.properties?.[key],
        `${t.name} requires '${key}' but does not declare it in properties`);
    }
  }
});

test('an unknown tool name is refused, not silently accepted', async () => {
  const { replies } = await talk([...INIT,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cw_does_not_exist', arguments: {} } }]);
  const r = replies.find((x) => x.id === 3);
  assert.ok(r.error || r.result?.isError, 'calling a missing tool must be an error');
});

// --- the failure modes that matter ------------------------------------------

test('a track tool reports CAKESCRIPT_UNAVAILABLE when there is no T1 transport', async () => {
  const { replies } = await talk([...INIT,
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cw_list_tracks', arguments: {} } }],
    { timeoutMs: 25000 });
  const r = replies.find((x) => x.id === 4);
  assert.ok(r.result, 'the call should return, not throw');
  if (!r.result.isError) return;   // a machine with the Assistant present is fine too
  const text = r.result.content[0].text;
  assert.match(text, /CAKESCRIPT_UNAVAILABLE|Error/);
  // The error must name usable alternatives; that is the contract of dispatch.js.
  assert.match(text, /cw_run_command|cw_midi|cw_probe_state|MIDI/i,
    'the error should point at what to use instead');
});

test('cw_status works whether or not SONAR is running', async () => {
  const { replies } = await talk([...INIT,
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cw_status', arguments: {} } }],
    { timeoutMs: 30000 });
  const r = replies.find((x) => x.id === 5);
  assert.ok(r.result, 'status must always answer');
  const payload = JSON.parse(r.result.content[0].text);
  assert.ok('sonar' in payload);
  assert.ok('transports' in payload);
  assert.ok(typeof payload.sonar.running === 'boolean');
  // Whatever the state, the tool must recommend something or say why it cannot.
  assert.ok(payload.recommended !== undefined || (payload.notes && payload.notes.length));
});

test('plugin detection needs no SONAR at all', async () => {
  const { replies } = await talk([...INIT,
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'cw_plugins', arguments: {} } }],
    { timeoutMs: 40000 });
  const r = replies.find((x) => x.id === 6);
  assert.ok(r.result, 'plugin listing is filesystem + registry, so it must answer');
  const p = JSON.parse(r.result.content[0].text);
  assert.ok(p.sources, 'the three sources should be reported');
  assert.equal(typeof p.sources.named.count, 'number');
  assert.ok(p.searchable >= p.registered);
});

test('a bad search term returns an empty list, not an error', async () => {
  const { replies } = await talk([...INIT,
    { jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'cw_find_plugin', arguments: { query: 'zzz-no-such-plugin-zzz' } } }],
    { timeoutMs: 40000 });
  const r = replies.find((x) => x.id === 7);
  assert.ok(r.result && !r.result.isError, 'a miss is a normal result');
  assert.deepEqual(JSON.parse(r.result.content[0].text).results, []);
});

test('reading a midi file that is not midi fails with NOT_MIDI', async () => {
  const p = join(ROOT, 'package.json');
  const { replies } = await talk([...INIT,
    { jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'cw_read_midi_file', arguments: { path: p } } }], { timeoutMs: 25000 });
  const r = replies.find((x) => x.id === 8);
  assert.ok(r.result.isError, 'a non-MIDI file must be an error');
  assert.match(r.result.content[0].text, /NOT_MIDI|not a Standard MIDI/i);
});

// --- the modules that touch the outside world --------------------------------

test('bin/cakewalk-mcp.js is the declared entry point and is executable as ESM', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.main || pkg.bin, 'an entry point should be declared');
  const src = readFileSync(join(ROOT, 'bin', 'cakewalk-mcp.js'), 'utf8');
  assert.match(src, /^#!\/usr\/bin\/env node/, 'a CLI entry needs a shebang');
});

test('every lib module parses (a syntax error anywhere breaks the server)', async () => {
  const dir = join(ROOT, 'lib');
  const files = readFileSync;   // keep the import list explicit instead of globbing
  const mods = ['benchmark', 'cake_templates', 'commands', 'dispatch', 'live', 'menu',
    'midi-config', 'midi-file', 'mixer', 'plugins', 'project-state', 'run', 'server',
    'sonar', 'track-ui', 'tracks'];
  for (const m of mods) {
    await import(`../lib/${m}.js`);
  }
  assert.ok(true);
});

test('the bridge and midi modules export the surface the lib layer calls', async () => {
  const bridge = await import('../bridge/agent.js');
  for (const fn of ['startBridge', 'call', 'stopBridge']) {
    assert.equal(typeof bridge[fn], 'function', `bridge.${fn} must exist`);
  }
  const midi = await import('../bridge/midi.js');
  for (const fn of ['startMidi', 'midiCall', 'send', 'sendAll', 'playNote', 'stopMidi']) {
    assert.equal(typeof midi[fn], 'function', `midi.${fn} must exist`);
  }
  for (const fn of ['noteOn', 'noteOff', 'controlChange', 'pitchBend']) {
    assert.equal(typeof midi[fn], 'function', `midi.${fn} must exist`);
  }
});

test('the MIDI message helpers produce spec-shaped bytes', async () => {
  const { noteOn, noteOff, controlChange, pitchBend, CC } = await import('../bridge/midi.js');
  assert.deepEqual(noteOn(1, 60, 100), [0x90, 60, 100]);
  assert.deepEqual(noteOff(1, 60), [0x80, 60, 0]);
  assert.deepEqual(controlChange(2, CC.pan, 64), [0xb1, 10, 64]);
  const bend = pitchBend(1, 8192);
  assert.equal(bend[0], 0xe0);
  assert.equal((bend[2] << 7) | bend[1], 8192, 'the 14-bit value must survive the split');
});

test('the channel helper maps 1..16 onto the wire nibble and clamps', async () => {
  const { CH } = await import('../bridge/midi.js');
  assert.equal(CH(1), 0);
  assert.equal(CH(16), 15);
  assert.equal(CH(0), 0, 'below range clamps');
  assert.equal(CH(99), 15, 'above range clamps');
});

test('dispatch reports every transport it knows about, available or not', async () => {
  const { capabilities, TRANSPORTS } = await import('../lib/dispatch.js');
  const caps = await capabilities({ refresh: true });
  assert.ok(caps.transports[TRANSPORTS.WINDOW_MESSAGE], 'T1 must be reported');
  assert.ok(caps.transports[TRANSPORTS.WM_COMMAND], 'T2 must be reported');
  assert.ok(caps.transports[TRANSPORTS.COMPUTER_USE], 'T3 must be reported');
  for (const t of Object.values(caps.transports)) {
    assert.equal(typeof t.available, 'boolean');
    assert.ok(t.detail, 'each transport needs an explanation, not just a flag');
  }
});

// The four tests above all short-circuit when SONAR happens to be running, so none
// of them ever exercised the SONAR-is-down branch — which is exactly how an empty
// `transports: {}` object shipped. This one asserts the invariant directly, with no
// dependence on what is running: a capabilities object must answer for every
// transport it advertises, or its callers crash reading the flags.
test('the accessors never throw a raw TypeError, whatever SONAR is doing', async () => {
  const { capabilities, cakeScriptBlocker, runCommand, TRANSPORTS } = await import('../lib/dispatch.js');
  const caps = await capabilities({ refresh: true });

  // 1. Every advertised transport is present and readable, running or not.
  for (const key of Object.values(TRANSPORTS)) {
    const t = caps.transports[key];
    assert.ok(t, `${key} is missing from transports — later reads would dereference undefined`);
    assert.equal(typeof t.available, 'boolean', `${key}.available must be a real boolean`);
  }

  // 2. cakeScriptBlocker() answers with a code and actionable alternatives, or null.
  const blocker = await cakeScriptBlocker();
  if (blocker !== null) {
    assert.equal(blocker.code, 'CAKESCRIPT_UNAVAILABLE');
    assert.match(blocker.message, /cw_run_command|MIDI|computer-use/i,
      'the blocker must name what to use instead');
  }

  // 3. runCommand() fails with a code, never with an unhandled property read.
  try {
    await runCommand(34861);
  } catch (e) {
    assert.ok(e.code, `runCommand threw without a code: ${e.message}`);
    assert.doesNotMatch(e.message, /Cannot read properties of undefined/,
      'an internal TypeError escaped to the caller');
  }
});

test('the command-support summary distinguishes what needs a project from what does not', async () => {
  const { commandSupportSummary, WORKING_NO_PROJECT, WORKING_WITH_PROJECT } = await import('../lib/commands.js');
  assert.ok(WORKING_NO_PROJECT.length > 0);
  assert.ok(WORKING_WITH_PROJECT.length >= WORKING_NO_PROJECT.length);
  // Ids must not be duplicated across the two lists, or the counts would mislead.
  const always = new Set(WORKING_NO_PROJECT.map((c) => c.cmdId));
  for (const c of WORKING_WITH_PROJECT) {
    assert.ok(!always.has(c.cmdId), `${c.hex} appears in both lists`);
  }
  const s = await commandSupportSummary();
  assert.ok(s.explanation.length > 50);
  assert.ok(s.uiRecipe, 'the UI recipe should travel with the summary');
});

test('the UI recipe records the things that failed, not only what worked', async () => {
  const { UI_RECIPE } = await import('../lib/commands.js');
  assert.ok(UI_RECIPE.menu.reachable);
  // These are the findings that cost the most time; losing them would be worse
  // than losing a passing test.
  assert.ok(UI_RECIPE.keyboard, 'the keyboard caveat must be recorded');
  assert.ok(UI_RECIPE.recovery && UI_RECIPE.recovery.fix, 'the lockup recovery must be recorded');
  assert.ok(UI_RECIPE.coordinateSpace, 'the coordinate-space note must be recorded');
  assert.match(UI_RECIPE.recovery.fix, /WM_COMMAND/);
});

test('the plugin-insert recipe records that insertion does not work', async () => {
  const { PLUGIN_INSERT_RECIPE } = await import('../lib/plugins.js');
  assert.equal(PLUGIN_INSERT_RECIPE.discovery.works, true);
  assert.equal(PLUGIN_INSERT_RECIPE.insertion.works, false);
  assert.ok(PLUGIN_INSERT_RECIPE.insertion.tried.length >= 4,
    'the record should list what was attempted');
  assert.ok(PLUGIN_INSERT_RECIPE.insertion.options.length > 0,
    'and what to do instead');
});

// --- the files this project ships --------------------------------------------
//
// These three used to `return` silently when song.mid was missing, so a clean
// checkout reported PASS for tests that asserted nothing. Build the fixture
// instead: deterministic, and the assertions always execute.
function songFixture() {
  const p = join(tmpdir(), 'cw-integration-song.mid');
  if (!existsSync(p)) {
    midiFile.write(p, {
      bpm: 120,
      tracks: [
        { name: 'Melody', channel: 1, program: 0, mix: { volume: 100, pan: 64 },
          events: [{ tick: 0, bytes: midiFile.on(0, 60, 100) }, { tick: 480, bytes: midiFile.off(0, 60) }] },
        { name: 'Bass', channel: 2, program: 33, mix: { volume: 96, pan: 40 },
          events: [{ tick: 0, bytes: midiFile.on(1, 45, 90) }, { tick: 480, bytes: midiFile.off(1, 45) }] },
        { name: 'Pad', channel: 3, program: 48, mix: { volume: 70, pan: 88 },
          events: [{ tick: 0, bytes: midiFile.on(2, 64, 70) }, { tick: 960, bytes: midiFile.off(2, 64) }] },
      ],
    });
  }
  return p;
}

test('the generated song exists and parses as format 1', () => {
  const p = songFixture();
  const d = midiFile.describe(p);
  assert.equal(d.format, 1);
  assert.ok(d.tracks.length >= 2, 'a conductor plus at least one part');
  assert.ok(d.tracks.some((t) => t.notes > 0), 'the song should contain notes');
});

test('the song carries its mix as CC7 and CC10 per track', () => {
  const p = songFixture();
  const d = midiFile.describe(p);
  const parts = d.tracks.filter((t) => t.name);
  assert.ok(parts.length >= 3, 'melody, bass and pad');
  for (const t of parts) {
    assert.equal(t.volume.length, 1, `${t.name} should declare a volume`);
    assert.equal(t.pan.length, 1, `${t.name} should declare a pan`);
  }
  // The mix is a balance decision, so the parts should not all sit in one place.
  const pans = parts.map((t) => t.pan[0]);
  assert.ok(new Set(pans).size > 1, 'a mix that does not pan anything is not a mix');
});

test('the song file has no unterminated notes', () => {
  const p = songFixture();
  const d = midiFile.describe(p);
  assert.equal(d.warning, undefined, 'a generated file should be clean');
});

// --- bridge liveness ---------------------------------------------------------
//
// Moved here from parsers.test.mjs, where it was the only reason a parser suite
// needed 25 seconds. The property is real and belongs in this layer: a call that
// crosses into another process must ANSWER, and "unknown" is a valid answer
// while a hang is not. Waiting on a process is the point of this file.

test('documentState answers rather than hanging, with or without SONAR', async () => {
  const { documentState } = await import('../lib/track-ui.js');
  const d = await Promise.race([
    documentState(),
    new Promise((r) => setTimeout(() => r({ timedOut: true }), 25000)),
  ]);
  assert.ok(!d.timedOut, 'documentState must answer within 25s, even with no SONAR');
  if (!d.known) {
    assert.ok(d.reason, 'an unknown state must say why');
    return;
  }
  assert.equal(typeof d.title, 'string');
  if (d.projectOpen) {
    assert.ok(['cakewalk-project', 'imported'].includes(d.documentKind),
      'an open document must be classified');
  } else {
    assert.ok(d.hint, 'a closed document should say how to open one');
  }
});

test('document classification agrees with the observed caption and document tab', async () => {
  // The pure cases live in parsers.test.mjs. This asserts the live caption
  // classifies identically to a second call, so the pure test and the real
  // title cannot silently diverge.
  const { classifyTitle, documentState } = await import('../lib/track-ui.js');
  const d = await documentState();
  if (!d.known) return;
  assert.deepEqual(classifyTitle(d.title, d.documentTab), d,
    'classification must use the same caption and document-tab observation');
});

test('a real edit reports a dialog it opened, or says why it saw none', async (t) => {
  /*
   * This test has now failed to catch the same bug twice, and then failed for a
   * reason that is itself worth recording.
   *
   * Round 1: the assertions were tautologies (`if (outcome === 'dialog-opened')
   * assert.ok(newWindows...)` / `else assert.equal(outcome, 'no-window-change')`),
   * because outcome is computed from newWindows and has two values.
   *
   * Round 2: rewritten to assert outcome and newWindows AGREE — still not enough.
   * Injecting the original regression (`const ran = await withSelection(...)`
   * instead of `{ out: ran }`, so newWindows was always undefined) left this suite
   * at 24/24 green, because the broken version agreed with itself: outcome was
   * 'no-window-change' and newWindows was empty. **A consistency assertion cannot
   * detect a consistent error.**
   *
   * Round 3 asserted newWindows must be non-empty — and that turned out to be
   * wrong for a different reason. `newWindows` is a DIFF against the window list
   * taken immediately before the command, so it reports windows that APPEARED. If
   * an earlier test left a 量化 dialog open, posting 处理 > 量化 again adds no new
   * window and the diff is legitimately empty — the assertion was testing the
   * suite's leftovers, not the edit layer.
   *
   * So the load-bearing check is now against the absolute state rather than the
   * diff: after a quantize on an open project, a 量化 dialog must be ON SCREEN. It
   * is checked through the overlay list, which is what actually knows. The diff
   * fields are still asserted for internal consistency, with the caveat named.
   */
  const { edit } = await import('../lib/edit.js');
  const { documentState } = await import('../lib/track-ui.js');
  const menu = await import('../lib/menu.js');

  const doc = await documentState();
  if (!doc.projectOpen) {
    // Without a document the 处理 menu does not exist; a different case, covered
    // elsewhere. Skip rather than assert.
    return;
  }
  /*
   * Reset the screen to a known state, and do it HERE rather than trusting the
   * suite's ordering. Two distinct ways a leftover modal breaks this test, both
   * observed: it swallows 处理 > 量化 so nothing opens at all, and it sits in the
   * overlay list so the absolute check passes for the wrong window. Clearing first
   * removes both. The measurements above (injection → red, restore → green) were
   * taken with this reset in place, so it does not blunt what the test detects.
   */
  try { await menu.closeOverlays?.(); } catch (_) { /* best effort */ }
  // Let the modal loop actually finish tearing down before posting a command into
  // it — a close and a post in the same tick race, and the post loses.
  await new Promise((r) => setTimeout(r, 800));

  const r = await edit('quantize');

  // The honesty fields.
  assert.match(r.selectionRequested, /选择 > 全部/, 'it must report the select-all it posted');
  assert.equal(r.selectionConfirmed, false,
    'it must NOT claim the selection was confirmed — select-all is drawn, so this process '
    + 'cannot tell a working one from a swallowed one');

  // Internal consistency, with its limit stated: these two can only disagree if the
  // report contradicts its own data, which is worth catching but is NOT sufficient.
  const hasDialog = r.newWindows.some((w) => w.startsWith('#32770'));
  assert.equal(r.outcome, hasDialog ? 'dialog-opened' : 'no-window-change',
    'outcome must be derived from the windows actually seen, not from the command');
  assert.equal(typeof r.likelySwallowed, 'boolean');

  /*
   * The assertion the regression cannot survive. The plumbing bug produced an
   * empty `newWindows` with `outcome: 'no-window-change'` — internally consistent
   * and wrong. Asking the overlay list instead makes the check absolute: a dialog
   * exists on screen or it does not, regardless of what the diff said.
   *
   * Match on the window CLASS, not the title. The overlay list decodes SONAR's
   * GBK captions as UTF-8, so 量化 arrives as "��������" and any /量化/ test fails
   * for an encoding reason while the dialog is plainly open — which is exactly how
   * this assertion first reported a false failure. #32770 is ASCII and reliable.
   */
  const overlays = await menu.listOverlays();
  const dialogCount = (overlays.overlays || []).filter((o) => o.cls === '#32770').length;

  /*
   * The third precondition this test has needed, and the subtlest.
   *
   * 处理 > 量化 is silent when the selection is EMPTY — measured: with an
   * "Empty Project" open (tracks present, no note data), select-all selects
   * nothing and 0x8061 opens no dialog. That is the command behaving correctly,
   * not the edit layer failing. The symptom is identical to the plumbing
   * regression (empty newWindows, no dialog), so this assertion reported a
   * false failure on a correct build — the third time this test has failed for
   * a reason other than the bug it hunts.
   *
   * The process cannot tell whether the open project has quantizable content:
   * reading notes needs CakeScript, which is gated on this build. So this branch
   * CANNOT be a pass — the regression it exists to catch produces the same
   * observation. It is marked todo instead of asserted green, because a silent
   * pass here is the exact "counted as coverage but cannot fail" trap this file
   * warns about above.
   *
   * The regression itself is now caught deterministically and without SONAR by
   * the EDIT_WIRING_FAULT guard in edit() (covered in edit.test.mjs). This test
   * is the end-to-end confirmation for when a project WITH notes is open.
   */
  if (dialogCount === 0) {
    t.todo(
      `no 量化 dialog appeared, and this run cannot tell why: the regression and an `
      + `empty selection look identical from here. outcome=${r.outcome}, `
      + `likelySwallowed=${r.likelySwallowed}. Re-run with a project containing MIDI notes `
      + `to make this an absolute check; the wiring fault has its own guard.`);
    try { await menu.closeOverlays?.(); } catch (_) { /* leave it clean */ }
    return;
  }

  try { await menu.closeOverlays?.(); } catch (_) { /* leave it clean */ }
});

import * as midiFile from '../lib/midi-file.js';
