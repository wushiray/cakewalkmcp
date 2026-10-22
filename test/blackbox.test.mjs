// test/blackbox.test.mjs — the whole adapter, exercised only through MCP.
//
// The white-box suites import lib modules and test their logic. This one does
// not import a single internal module: it spawns `bin/cakewalk-mcp.js` as a
// client would, speaks JSON-RPC over stdio, and judges only what comes back on
// the wire. That is the difference that matters — a refactor that keeps every
// unit test green can still break the protocol, the tool schemas, or the
// promise that an error is actionable.
//
// It is also the only suite that can catch a wiring mistake: a module that works
// perfectly but is never registered as a tool is invisible from inside.
//
// The rules this suite holds the adapter to, as a black box:
//   1. every tool is callable and answers within a bounded time
//   2. no tool throws an unhandled error at the protocol level
//   3. an error is a well-formed result with a readable message, never a timeout
//   4. a missing precondition is reported as such, with what to do
//   5. nothing that discards work happens without an explicit confirmation

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'bin', 'cakewalk-mcp.js');

/** One long-lived server for the whole file, spoken to like a real client. */
class Client {
  constructor() {
    this.child = spawn('node', [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
    this.buf = '';
    this.pending = new Map();
    this.stderr = '';
    this.nextId = 1;

    this.child.stdout.on('data', (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }  // log noise is not a reply
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr += d.toString(); });
  }

  send(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A black-box test must fail on a hang, not wait forever. 60s is the default
      // because a client's patience is the thing being modelled — but it is
      // overridable, because a tool that is slow BY DESIGN (cw_verify_commands
      // awaits the UI per probe) needs a bound that matches its documented cost
      // rather than having its arguments quietly reduced to fit a fixed timeout.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `no reply to ${method} within ${timeoutMs}ms; stderr: ${this.stderr.slice(0, 300)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async init() {
    const r = await this.send('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'blackbox', version: '1' },
    });
    this.notify('notifications/initialized');
    return r;
  }

  /** Call a tool and return its first text content block. */
  async call(name, args = {}, { timeoutMs = 60_000 } = {}) {
    const r = await this.send('tools/call', { name, arguments: args }, timeoutMs);
    if (r.error) return { protocolError: r.error, text: null };
    const text = r.result?.content?.find((c) => c.type === 'text')?.text ?? null;
    return { isError: !!r.result?.isError, text, raw: r.result };
  }

  close() { try { this.child.kill(); } catch (_) {} }
}

const client = new Client();
let TOOLS = [];

test.before(async () => {
  await client.init();
  const r = await client.send('tools/list');
  TOOLS = r.result.tools;
});
test.after(async () => {
  // Close any modal this suite opened before the client goes away. A dialog left
  // on screen swallows the next run's menu commands, which makes an unrelated
  // suite fail for an inherited reason — see the same hook in integration.test.mjs.
  try { await client.call('cw_close_overlays'); } catch (_) { /* best effort */ }
  client.close();
});

// Tools that are slow by design, with the ceiling their own documentation implies.
// Shared by the walking test (which needs a matching timeout) and the no-hang test
// (which needs a per-tool bar), so the two cannot disagree about what is acceptable.
const DELIBERATELY_SLOW = new Map([
  ['cw_verify_commands', 45_000],   // ~15s per probe; the default budget bounds it
  ['cw_add_song_tracks', 90_000],   // ~19s per insert; the default budget bounds it
]);

// --- 1. the surface is complete and self-consistent ---------------------------

test('initialize identifies the server', async () => {
  const c = new Client();
  const r = await c.init();
  c.close();
  assert.equal(r.result.serverInfo.name, 'cakewalk-mcp');
  assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
});

test('tools/list is non-trivial and every entry is well formed', () => {
  assert.ok(TOOLS.length >= 60, `expected the full surface, got ${TOOLS.length}`);
  for (const t of TOOLS) {
    assert.match(t.name, /^cw_[a-z0-9_]+$/, `bad name: ${t.name}`);
    assert.ok(t.description.length > 20, `${t.name} needs a usable description`);
    assert.equal(t.inputSchema.type, 'object');
    for (const key of t.inputSchema.required ?? []) {
      assert.ok(t.inputSchema.properties?.[key], `${t.name}: required '${key}' not declared`);
    }
  }
});

test('tool names are unique', () => {
  const seen = new Set();
  for (const t of TOOLS) {
    assert.ok(!seen.has(t.name), `duplicate tool: ${t.name}`);
    seen.add(t.name);
  }
});

test('every advertised tool can actually be called', async () => {
  /*
   * A tool that exists in the schema but throws on an empty call is a wiring bug
   * this suite is the only place to catch. Tools needing arguments legitimately
   * fail validation, so that is accepted — what is not accepted is a protocol error
   * or a hang.
   *
   * Called with NO arguments, so this exercises the defaults a client actually
   * gets. It used to pass `budgetMs: 3000` to cw_verify_commands, and that override
   * is exactly what hid the defect it should have caught: the product default was
   * 45s against a 58.7s workload. A test that substitutes its own arguments reports
   * on the test, not the tool.
   *
   * The cost of dropping the override is that one tool is genuinely slow —
   * cw_verify_commands posts each command and waits for the UI, ~15s per probe — so
   * its budget needs a timeout to match, rather than the value being quietly
   * lowered. `client.call` takes timeoutMs for this.
   */
  const noArg = TOOLS.filter((t) => !(t.inputSchema.required ?? []).length);
  assert.ok(noArg.length >= 15, 'a good number of tools should be callable with no arguments');
  for (const t of noArg) {
    const r = await client.call(t.name, {}, { timeoutMs: DELIBERATELY_SLOW.get(t.name) ?? 20_000 });
    assert.ok(!r.protocolError, `${t.name} produced a protocol error: ${JSON.stringify(r.protocolError)}`);
    assert.ok(r.text !== null, `${t.name} returned no text content`);
  }
});

test('a long survey tool returns a partial result rather than hanging', async () => {
  // The contract that replaced the hang: a bounded survey says what it did not
  // get to, instead of leaving the client waiting.
  //
  // Called with NO budget, so this exercises the default a real client gets. An
  // earlier version passed budgetMs:3000, which is why a 45 s default went
  // unnoticed against a 58.7 s workload.
  const t0 = Date.now();
  const r = await client.call('cw_verify_commands', {});
  const elapsed = Date.now() - t0;
  assert.ok(!r.isError, `verify failed: ${r.text}`);
  assert.ok(elapsed < 25_000,
    `the default budget must return inside a client's patience; took ${elapsed}ms`);

  const v = JSON.parse(r.text);
  assert.ok(typeof v.probed === 'number');
  assert.ok(Array.isArray(v.notProbed));
  // Three honest outcomes: measured, skipped, or attempted-and-failed. A
  // transport failure (SONAR closed) lands in `errors`, and that is a result.
  assert.equal(v.documentOpen === false || v.probed + v.notProbed.length + v.errors.length > 0, true,
    'a survey must report work done, work skipped, or why it failed');
  for (const e of v.errors) assert.ok(e.error, 'a failed probe must carry the reason');
  if (v.partial) {
    assert.ok(v.partialNote, 'a partial survey must say so');
    assert.ok(v.notProbed.length > 0, 'and name what it skipped');
  }
});

test('a tool that requires arguments reports a validation error, not a crash', async () => {
  const needs = TOOLS.filter((t) => (t.inputSchema.required ?? []).length > 0);
  assert.ok(needs.length > 0);
  const t = needs[0];
  const r = await client.call(t.name, {});
  assert.ok(!r.protocolError, `${t.name} should not raise a protocol error`);
  // Either it is flagged as an error, or it answered with a default.
  assert.ok(r.isError || r.text, `${t.name} gave neither an error nor an answer`);
});

// --- 1b. no tool may hang -----------------------------------------------------
//
// A bare tools/call that never returns is the worst failure a client can hit: it
// reads as a dead server rather than a slow tool. Three did exactly that, found
// when the walking test above timed out at 60 s — cw_add_song_tracks (six inserts),
// cw_benchmark and cw_latency (both reading the 946-entry plugin inventory).
//
// One tool is genuinely slow and cannot be made fast: cw_verify_commands posts each
// command and waits for the UI, ~15 s per probe, so a 21-command survey is minutes.
// It is listed here with its own ceiling rather than being exempted, because "it is
// slow on purpose" is exactly the claim that needs a number attached — an earlier
// version of this test silently excluded it by passing budgetMs:3000, a value no
// client would ever use, and so never noticed that the product default was 45 s
// against a 58.7 s workload.
//
// This test must call each tool the way a CLIENT would — with NO arguments at all,
// taking the schema's own defaults. A test that substitutes its own arguments
// cannot report on the defaults a user will actually get.


test('no zero-argument tool runs past the time its own description implies', async () => {
  const noArg = TOOLS.filter((t) => !(t.inputSchema.required ?? []).length);
  const slow = [];
  for (const t of noArg) {
    const ceiling = DELIBERATELY_SLOW.get(t.name) ?? 25_000;
    const t0 = Date.now();
    const r = await client.call(t.name, {});      // defaults only — that IS the contract
    const ms = Date.now() - t0;
    assert.ok(!r.protocolError, `${t.name} produced a protocol error`);
    if (ms > ceiling) slow.push(`${t.name} took ${ms}ms, ceiling ${ceiling}ms`);
  }
  assert.deepEqual(slow, [],
    'these tools exceed the wait their own description implies — give them a budget that '
    + 'matches their per-item cost, or make the expensive stages opt-in');
});

// --- 2. errors are actionable -------------------------------------------------

test('an unknown tool is refused in a well-formed way', async () => {
  const r = await client.call('cw_not_a_tool');
  assert.ok(r.protocolError || r.isError, 'a missing tool must be an error');
});

test('an unknown navigation command names the valid ones', async () => {
  const r = await client.call('cw_navigate', { command: 'fly' });
  // The enum rejects it at the schema level, which is the strongest form.
  assert.ok(r.protocolError || r.isError);
});

test('calling a track tool without the T1 transport explains the alternatives', async () => {
  const r = await client.call('cw_list_tracks');
  assert.ok(!r.protocolError, 'must answer, not throw');
  if (!r.isError) return;   // a machine with the Assistant panel present is also fine
  assert.match(r.text, /CAKESCRIPT_UNAVAILABLE|Error/);
  assert.match(r.text, /MIDI|cw_run_command|cw_probe_state/,
    'the error has to name something usable instead');
});

test('a destructive tool refuses and says how to confirm', async () => {
  for (const [name, args] of [
    ['cw_project', { command: 'close' }],
    ['cw_edit', { command: 'normalize' }],
  ]) {
    const r = await client.call(name, args);
    assert.ok(r.isError, `${name} should refuse without confirmation`);
    assert.match(r.text, /confirm/i, `${name} must say how to proceed`);
  }
});

test('reading a non-MIDI file as MIDI is an error with a reason', async () => {
  const r = await client.call('cw_read_midi_file', { path: join(ROOT, 'package.json') });
  assert.ok(r.isError);
  assert.match(r.text, /MIDI/i);
});

// --- 3. output is machine-readable where it claims to be -----------------------

test('the JSON-returning tools actually return JSON', async () => {
  const jsonTools = [
    ['cw_status', {}, 30000],
    ['cw_document_state', {}, 20000],
    ['cw_plugins', {}, 30000],
    ['cw_command_evidence', {}, 15000],
    ['cw_no_effect_causes', {}, 15000],
    ['cw_edit_help', {}, 15000],
    ['cw_markers', {}, 15000],
    ['cw_plugins', {}, 30000],
  ];
  for (const [name, args] of jsonTools) {
    const r = await client.call(name, args);
    assert.ok(!r.protocolError, `${name}: ${JSON.stringify(r.protocolError)}`);
    if (r.isError) continue;   // a legitimately unavailable tool is not a failure here
    assert.doesNotThrow(() => JSON.parse(r.text), `${name} claims to return JSON but does not`);
  }
});

test('cw_status always answers with a shape a client can branch on', async () => {
  const r = await client.call('cw_status');
  assert.ok(!r.isError, 'status must never fail');
  const s = JSON.parse(r.text);
  assert.ok('sonar' in s && 'transports' in s);
  for (const [name, t] of Object.entries(s.transports)) {
    assert.equal(typeof t.available, 'boolean', `${name} needs a boolean availability`);
    assert.ok(t.detail, `${name} needs an explanation a client can show`);
  }
  assert.ok(s.recommended !== null || s.notes.length > 0,
    'either recommend a transport or say why none is available');
});

test('cw_command_evidence reports both groups and explains the distinction', async () => {
  const r = await client.call('cw_command_evidence');
  const e = JSON.parse(r.text);
  assert.ok(e.total > 0);
  assert.equal(e.confirmed + e.unconfirmed, e.total);
  assert.ok(e.noEffectCauses?.length === 3, 'the three-cause taxonomy must be exposed');
  assert.ok(e.reading.includes('not mean broken'));
});

test('cw_edit_help exposes the precondition rule, not just a command list', async () => {
  const r = await client.call('cw_edit_help');
  const h = JSON.parse(r.text);
  assert.ok(h.commands && h.dialogs);
  assert.equal(h.whyPreconditionsMatter.causes.length, 3);
});

// --- 4. the plugin surface, which needs no SONAR ------------------------------

test('cw_plugins answers regardless of SONAR and reports three sources', async () => {
  const r = await client.call('cw_plugins');
  assert.ok(!r.isError, 'plugin detection is filesystem + registry, so it must answer');
  const p = JSON.parse(r.text);
  assert.equal(typeof p.sources.named.count, 'number');
  assert.equal(typeof p.sources.scannedUnnamed.count, 'number');
  assert.ok(p.searchable >= p.registered);
});

test('cw_find_plugin returns a list for a hit and an empty list for a miss', async () => {
  const hit = await client.call('cw_find_plugin', { query: 'e' });
  assert.ok(!hit.isError);
  assert.ok(JSON.parse(hit.text).results.length > 0);

  const miss = await client.call('cw_find_plugin', { query: 'zzz-no-such-plugin-zzz' });
  assert.ok(!miss.isError, 'a miss is a normal result, not an error');
  assert.deepEqual(JSON.parse(miss.text).results, []);
});

test('every plugin result carries a format and a presence flag', async () => {
  const r = await client.call('cw_find_plugin', { query: 'EZ', limit: 20 });
  const results = JSON.parse(r.text).results;
  assert.ok(results.length > 0);
  for (const p of results) {
    assert.ok(p.name, 'a result needs a name');
    assert.equal(typeof p.present, 'boolean', `${p.name} needs a presence flag`);
  }
});

// --- 5. MIDI file round trip through the protocol -----------------------------

test('a file written by cw_write_midi_file reads back identically', async () => {
  // temp dir, not the repo: these files used to accumulate in test/ and the
  // second run of the suite then hit the writer's new overwrite guard.
  const path = join(tmpdir(), 'cakewalk-mcp-blackbox-song.mid');
  const w = await client.call('cw_write_midi_file', {
    path,
    overwrite: true,
    bpm: 100,
    tracks: [{
      name: 'BB', channel: 4, program: 25, volumeCC: 99, panCC: 40,
      notes: [{ tick: 0, pitch: 62, velocity: 90, duration: 240 },
        { tick: 480, pitch: 65, velocity: 88, duration: 240 }],
    }],
  });
  assert.ok(!w.isError, `write failed: ${w.text}`);
  const written = JSON.parse(w.text);
  assert.equal(written.warnings, undefined, 'a consistent track should not warn');

  const rd = await client.call('cw_read_midi_file', { path, includeNotes: true });
  assert.ok(!rd.isError);
  const d = JSON.parse(rd.text);
  const track = d.tracks.find((t) => t.name === 'BB');
  assert.ok(track, 'the named track should come back');

  /*
   * "Identically" has to mean the VALUES, not just the counts.
   *
   * This test was named "reads back identically" and asserted note count, channel
   * and volume — but never a pitch, a velocity, a duration or the pan's value. A
   * writer that dropped every note while keeping the header would have passed it.
   * An adversarial audit flagged the gap; includeNotes is what closes it, and the
   * exact written values are now checked back.
   */
  assert.equal(track.notes, 2);
  assert.deepEqual(track.channels, [4]);
  assert.deepEqual(track.volume, [99]);
  assert.equal(track.pan[0], '38% left', 'the pan must decode to the position written');

  const notes = d.notes[1];   // track 0 is the conductor; 'BB' is track 1
  assert.ok(Array.isArray(notes) && notes.length === 2, 'both notes must survive the round trip');
  assert.deepEqual(notes.map((n) => [n.tick, n.pitch, n.velocity, n.duration]),
    [[0, 62, 90, 240], [480, 65, 88, 240]],
    'every written note field must come back unchanged, in the same order');
});

test('the writer warns when a track mixes channels', async () => {
  // The channel decides which SONAR track a CC7/CC10 lands on, so a mismatch is
  // silent in the DAW — the tool has to be the one that complains.
  //
  // This test used to call cw_write_midi_file with `notes` on the same channel the
  // track declared, and then assert only `!isError`. In that shape the tool builds
  // every event on the declared channel, so no warning is possible and the test
  // could not fail — it was named for a warning it never looked at. An adversarial
  // audit caught that. The path that CAN warn is a hand-built `events` list, which
  // is what the plugin's own writer uses; that is what is exercised here.
  const path = join(tmpdir(), 'cakewalk-mcp-blackbox-bad.mid');
  const w = await client.call('cw_write_midi_file', {
    path,
    overwrite: true,
    tracks: [{
      name: 'bad',
      channel: 5,                                   // declared channel 5
      events: [
        { tick: 0, bytes: [0x90, 60, 100] },        // but the note is on channel 1
        { tick: 100, bytes: [0x80, 60, 0] },
      ],
    }],
  });
  assert.ok(!w.isError, `write reported an error: ${w.text}`);
  const written = JSON.parse(w.text);
  assert.ok(Array.isArray(written.warnings) && written.warnings.length > 0,
    'a channel mismatch must produce a warning, not silence');
  /*
   * Assert the CONTENT, not just that something was said. The previous version
   * checked `warnings.length > 0` and `/channel/i`, so a warning reading "events
   * use channel(s) 99 but the track is declared as channel 99" — self-contradictory
   * and useless — would have passed. A verifier pointed that out.
   *
   * The numbers here are the point: the note bytes are 0x90/0x80 (channel 1 on the
   * wire) while the track declares channel 5. Both must appear, and they must not be
   * the same.
   */
  const warn = written.warnings[0];
  assert.match(warn, /\b1\b/, 'the warning must name the channel the events actually use');
  assert.match(warn, /\b5\b/, 'and the channel the track declares');
  assert.match(warn, /wrong track/, 'and say what the consequence is');

  // The clean case, so the assertion above cannot pass by warning unconditionally.
  const ok = await client.call('cw_write_midi_file', {
    path: join(tmpdir(), 'cakewalk-mcp-blackbox-ok.mid'),
    overwrite: true,
    tracks: [{
      name: 'ok',
      channel: 5,
      events: [
        { tick: 0, bytes: [0x94, 60, 100] },        // channel 5, matching the declaration
        { tick: 100, bytes: [0x84, 60, 0] },
      ],
    }],
  });
  const okWritten = JSON.parse(ok.text);
  assert.equal(okWritten.warnings, undefined, 'a consistent track must not warn');
});

// --- 6. the benchmark, as a client would read it ------------------------------

test('cw_benchmark returns a verdict with confirmation methods attached', async () => {
  // `full: false` is the default and what a bare call gets; the point of this
  // shape is that the expensive plugin stages are opt-in, so a client without a
  // long timeout still gets an answer. See the cw_benchmark description.
  const r = await client.call('cw_benchmark', { includePluginScan: false, includeMidiSend: false });
  assert.ok(!r.isError, `benchmark failed: ${r.text}`);
  const b = JSON.parse(r.text);
  assert.ok(b.summary.total > 5, `expected a real sweep, got ${b.summary.total} cases`);
  assert.equal(b.summary.passed + b.summary.failed + b.summary.errors, b.summary.total);
  for (const c of b.cases) {
    assert.ok(c.confirmation, `${c.name} must state how it was confirmed`);
    assert.ok(['pass', 'fail', 'error'].includes(c.status));
  }
  assert.ok(b.legend.confirmation.independent, 'the confirmation classes must be explained');

  // A sweep that omitted stages must say which, or a short run reads as a
  // complete one. This is the contract the plugin-stage change introduced.
  assert.ok(Array.isArray(b.skipped), 'the result must report skipped stages');
  assert.equal(b.partial, b.skipped.length > 0);
  if (b.partial) {
    assert.ok(b.partialNote, 'a partial sweep must say what it left out and why');
    assert.ok(b.skipped.includes('read plugin inventory'),
      'the expensive stage is the one that gets skipped');
  }
});

test('cw_latency profiles the operations a client would use', async () => {
  const r = await client.call('cw_latency');
  assert.ok(!r.isError);
  const l = JSON.parse(r.text);
  assert.ok(l.samples.length >= 3);
  for (const s of l.samples) {
    assert.equal(typeof s.medianMs, 'number');
    assert.ok(s.medianMs >= 0 && s.medianMs < 60000, `${s.name} has an implausible latency`);
    // A sample with no runs would carry undefined timings, which reads like a
    // measurement that was taken. Only measured stages may appear.
    assert.ok(s.runs > 0, `${s.name} was never actually run`);
  }
  // The plugin-read stage is opt-in, so a bare call must declare its absence.
  assert.ok(Array.isArray(l.skipped), 'latency must report what it did not measure');
});

// --- 7. the server survives a hard client -------------------------------------

test('the server does not die from a burst of requests', async () => {
  const burst = [];
  for (let i = 0; i < 8; i++) burst.push(client.call('cw_document_state'));
  const results = await Promise.all(burst);
  for (const r of results) {
    assert.ok(!r.protocolError, 'a burst must not break the transport');
    assert.ok(r.text, 'every request in a burst must be answered');
  }
});

test('the server still answers after all of the above', async () => {
  const r = await client.call('cw_document_state');
  assert.ok(!r.protocolError);
  assert.ok(JSON.parse(r.text).known !== undefined);
});
