// test/template-verification.test.mjs — insertTrackTemplate's verification policy.
//
// The LAST function in lib/track-ui.js is pulled out of the real source text and
// evaluated with its module-level collaborators replaced by fakes, so the tests
// pin the shipped code itself rather than a copy of it.
//
// What is pinned here:
//   - a failed baseline snapshot aborts BEFORE the insert is invoked;
//   - a transient post-insert readback failure followed by a new matching track
//     is `verified: true`;
//   - a persistent post-insert readback failure is not an insertion error: it is
//     insertionRequested + verified:false plus a diagnostic;
//   - an old track with the same name/id is never claimed as the new one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'track-ui.js'), 'utf8');

// --- extract the LAST function from the real source --------------------------
const start = SOURCE.lastIndexOf('export async function insertTrackTemplate');
assert.ok(start >= 0, 'insertTrackTemplate not found in lib/track-ui.js');
const src = 'async function insertTrackTemplate' + SOURCE.slice(start + 'export async function insertTrackTemplate'.length);
assert.ok(/^async function insertTrackTemplate\(/.test(src));

// The extracted body ends at the end of that function. Everything after it in
// the file is only a trailing newline (it is the last declaration).
assert.ok(SOURCE.slice(start).trimEnd().endsWith('}'), 'function must be last in the file');

const build = (fakes) => new Function(
  'existsSync', 'findTrackTemplate', 'dumpTrackControls', 'runUia', 'runCommand', 'setTimeout',
  `${src}\nreturn insertTrackTemplate;`,
)(fakes.existsSync, fakes.findTrackTemplate, fakes.dumpTrackControls,
  fakes.runUia, fakes.runCommand, fakes.setTimeout);

const controls = (entries) => Promise.resolve(
  entries.map(([label, track]) => ({ label, track, name: `${label} on Track ${track}` })));

const immediate = (fn) => Promise.resolve(fn());   // setTimeout(handler) with no wall clock
const noWait = (res) => { res(); return { unref() {} }; };

// --- 1. baseline snapshot failure aborts without inserting -------------------
test('a failed baseline snapshot aborts before the insert is invoked', async () => {
  const calls = { uia: 0, command: 0 };
  const fn = build({
    existsSync: () => false,
    findTrackTemplate: () => ({ name: 'Bass Jazz Club', file: 'C:/t/Bass Jazz Club.cwx' }),
    dumpTrackControls: () => Promise.reject(new Error('no top-level window for pid26876')),
    runUia: () => { calls.uia++; return Promise.resolve({ ok: true }); },
    runCommand: () => { calls.command++; return Promise.resolve({ ok: true }); },
    setTimeout: noWait,
  });
  await assert.rejects(() => fn('Bass Jazz Club', { openDialog: true }),
    /no top-level window for pid26876/);
  assert.equal(calls.uia, 0, 'the insert must not be invoked');
  assert.equal(calls.command, 0, 'nothing may be attempted before the baseline');
});

// --- 2. transient post-insert failure, new track appears => verified ---------
test('a transient post-insert read failure followed by a new track verifies', async () => {
  let dumps = 0;
  const uiaArgs = [];
  const fn = build({
    existsSync: () => false,
    findTrackTemplate: () => ({ name: 'Bass Jazz Club', file: 'C:/t/Bass Jazz Club.cwx' }),
    dumpTrackControls: () => {
      dumps++;
      if (dumps === 1) return controls([['音量', 1], ['音量', 2]]);          // baseline
      if (dumps <= 3) return Promise.reject(new Error('no top-level window for pid26876'));
      return controls([['音量', 1], ['音量', 2], ['Bass Jazz Club', 4]]);
    },
    runUia: (args) => { uiaArgs.push(args); return Promise.resolve({ ok: true }); },
    runCommand: () => Promise.resolve({ ok: true }),
    setTimeout: immediate,
  });
  const out = await fn('Bass Jazz Club');
  assert.equal(uiaArgs[0][1], 'inserttemplate');
  assert.equal(out.verified, true);
  assert.equal(out.track, 4);
  assert.equal(out.template, 'Bass Jazz Club');
  assert.equal(out.warning, undefined);
});

// --- 3. persistent post-insert failure => requested, not verified -----------
test('a persistent post-insert read failure reports requested + unverified', async () => {
  let dumps = 0;
  const fn = build({
    existsSync: () => false,
    findTrackTemplate: () => ({ name: 'Bass Jazz Club', file: 'C:/t/Bass Jazz Club.cwx' }),
    dumpTrackControls: () => {
      dumps++;
      if (dumps === 1) return controls([['音量', 1]]);
      return Promise.reject(new Error('no top-level window for pid26876'));
    },
    runUia: () => Promise.resolve({ ok: true }),
    runCommand: () => Promise.resolve({ ok: true }),
    setTimeout: immediate,
  });
  const out = await fn('Bass Jazz Club');
  assert.equal(out.verified, false);
  assert.equal(out.insertionRequested, true);
  assert.equal(out.track, null);
  assert.match(out.verificationError, /no top-level window for pid26876/);
  assert.equal(out.readFailures, 8);
  assert.match(out.warning, /requested/i);
  assert.match(out.warning, /not confirmed/i);
  assert.match(out.warning, /do NOT simply re-run the insert/i);
});

// --- 4. an existing matching track is not claimed as the new one ------------
test('a pre-existing name-matched track id never counts as verified', async () => {
  let dumps = 0;
  const fn = build({
    existsSync: () => false,
    findTrackTemplate: () => ({ name: 'Bass Jazz Club', file: 'C:/t/Bass Jazz Club.cwx' }),
    dumpTrackControls: () => {
      dumps++;
      // The strip was already there before the insert, and still is.
      return controls([['Bass Jazz Club', 4], ['音量', 4]]);
    },
    runUia: () => Promise.resolve({ ok: true }),
    runCommand: () => Promise.resolve({ ok: true }),
    setTimeout: immediate,
  });
  const out = await fn('Bass Jazz Club');
  assert.equal(dumps, 1 + 8);
  assert.equal(out.verified, false);
  assert.equal(out.insertionRequested, true);
  assert.equal(out.track, null);
  assert.equal(out.verificationError, undefined, 'reads succeeded — nothing to diagnose');
});

// --- 5. a native invocation error stays an error ----------------------------
test('a rejected invocation is still an error, not an unverified insert', async () => {
  let dumps = 0;
  const fn = build({
    existsSync: () => false,
    findTrackTemplate: () => ({ name: 'Bass Jazz Club', file: 'C:/t/Bass Jazz Club.cwx' }),
    dumpTrackControls: () => { dumps++; return controls([['音量', 1]]); },
    runUia: () => Promise.reject(new Error('UIA helper reported failure')),
    runCommand: () => Promise.resolve({ ok: true }),
    setTimeout: immediate,
  });
  await assert.rejects(() => fn('Bass Jazz Club'), /UIA helper reported failure/);
  assert.equal(dumps, 1, 'no post-insert polling after a failed invocation');
});
