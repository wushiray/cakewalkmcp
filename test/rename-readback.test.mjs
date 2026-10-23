import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// Regression for the `rename` read-back in native/uia/cw_uia.ps1.
//
// Confirmed on a host: a Chinese rename actually took effect on screen, yet the
// tool reported after:null / verified:false. The initial row anchor looped over
// the mute aliases, but the post-rename read-back interpolated the whole alias
// ARRAY into a single name ("absent-alias Mute on Track 1"), which matches no
// element. With no anchor, $after never got set and the write looked failed.
//
// This test never loads a host DLL or a UI automation assembly: it spawns the
// fixture, which extracts the real 'rename' switch body from the script with
// the PowerShell AST and runs it against stubs.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'rename-readback.ps1');
const scriptPath = path.join(here, '..', 'native', 'uia', 'cw_uia.ps1');

function powershellExe() {
  const candidates = ['powershell', 'pwsh'];
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

const ps = powershellExe();

function runFixture(initialName) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', fixture,
    '-Script', scriptPath,
  ];
  if (initialName) args.push('-InitialName', initialName);
  const res = spawnSync(ps, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(res.error, undefined, `could not run ${ps}: ${res.error && res.error.message}`);
  assert.equal(res.status, 0, `fixture exited ${res.status}: ${res.stderr}`);
  const line = String(res.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  assert.ok(line, `fixture produced no output. stderr: ${res.stderr}`);
  return JSON.parse(line);
}

test('the fixture and the script under test are present', () => {
  assert.ok(fs.existsSync(fixture), 'fixture missing');
  assert.ok(fs.existsSync(scriptPath), 'cw_uia.ps1 missing');
});

test('fixture extracts the actual rename switch clause', { skip: ps ? false : 'no PowerShell available' }, () => {
  const out = runFixture('Old');
  assert.equal(out.ok, true);
  assert.equal(out.clauseFound, true);
  assert.equal(out.failure, null, `branch threw: ${out.failure}`);
  // A real extracted body, not an empty one.
  assert.ok(out.statementCount > 5, `only ${out.statementCount} statements captured`);
  assert.ok(out.branch, 'branch emitted no JSON');

  // The branch's own statements are executed: it clicked and it emitted the
  // fields only the real rename clause emits.
  assert.equal(out.branch.ok, true);
  assert.equal(out.branch.track, 1);
  assert.equal(out.branch.requested, 'New');
  assert.ok(out.branch.clicked, 'clicked missing');
});

test('rename read-back re-anchors through every mute alias and verifies the new name',
  { skip: ps ? false : 'no PowerShell available' }, () => {
    const out = runFixture('Old');
    assert.equal(out.failure, null);
    const branch = out.branch;
    assert.ok(branch, 'no branch output');

    // The write actually happened: the post-write generation was read.
    assert.equal(out.afterWriteSeen, true, 'Get-Root was never called after the write');

    // The whole point: a succeeded rename must report verified=true.
    assert.equal(branch.before, 'Old');
    assert.equal(branch.after, 'New');
    assert.equal(branch.changed, true);
    assert.equal(branch.verified, true);
    assert.equal(branch.alreadyThere, undefined);

    // The read-back found the anchor at all. With the old code $m2 was null, so
    // $after stayed null; asserting `after === 'New'` above is what fails then.
    assert.notEqual(branch.after, null);
  });

test('an already-correct name short-circuits before any write',
  { skip: ps ? false : 'no PowerShell available' }, () => {
    const out = runFixture('New');
    assert.equal(out.failure, null);
    const branch = out.branch;
    assert.ok(branch, 'no branch output');
    assert.equal(branch.ok, true);
    assert.equal(branch.alreadyThere, true);
    assert.equal(branch.changed, false);
    assert.equal(branch.verified, true);
    assert.equal(branch.before, 'New');
    assert.equal(branch.after, 'New');
    assert.equal(branch.clicked, undefined);
  });
