// Offline CAL isolation: the no-host test preload must never let cleanup touch
// a real (user) CAL folder. Stdlib only; imports nothing but lib/sonar.js in
// the child, and lib/sonar.js only pulls Node builtins. Never imports the
// server, never touches a host or the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(HERE, 'offline-host.cjs');
const SONAR_URL = pathToFileURL(join(HERE, '..', 'lib', 'sonar.js')).href;
const CANARY = 'MCP-setDuration.CAL';
const CANARY_BODY = '; canary — a real user CAL script that must survive\n';

const CAL_ENV = 'CAKEWALK_MCP_TEST_CAL_FOLDER';
const ROOT_ENV = 'CW_OFFLINE_CAL_ROOT';

const madeDirs = [];

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(d);
  return d;
}

function fakeUserCalFolder() {
  const dir = tempDir('cw-user-cal-');
  writeFileSync(join(dir, CANARY), CANARY_BODY, 'utf8');
  writeFileSync(join(dir, 'MCP-other.CAL'), '; another user script\n', 'utf8');
  return dir;
}

// Child program: import the real module path, write/delete only inside the
// folder it resolved, and report that absolute folder back on stdout.
function childSource() {
  return `
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { calFolder } from ${JSON.stringify(SONAR_URL)};
const folder = calFolder();
const target = join(folder, ${JSON.stringify(CANARY)});
writeFileSync(target, '; written by offline isolation child\\n', 'utf8');
const wrote = existsSync(target);
rmSync(target, { force: true });
const deleted = !existsSync(target);
process.stdout.write(JSON.stringify({ folder, wrote, deleted }) + '\\n');
`;
}

function runChild({ preload = true, env = {} } = {}) {
  const args = [];
  if (preload) args.push('--require', PRELOAD);
  args.push('--input-type=module', '-e', childSource());
  const child = spawnSync(process.execPath, args, {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 25000,
    env: { ...process.env, NODE_OPTIONS: '', ...env },
  });
  // On timeout spawnSync reports `error` and a null status; surface it.
  if (child.error) throw child.error;
  const line = (child.stdout || '').trim().split('\n').filter(Boolean).pop();
  return { child, line };
}

function parseChild(result) {
  assert.equal(result.child.status, 0, `child failed: ${result.child.stderr}`);
  assert.ok(result.line, `child produced no output; stderr: ${result.child.stderr}`);
  const parsed = JSON.parse(result.line);
  assert.equal(parsed.wrote, true, 'child could not write its scratch CAL file');
  assert.equal(parsed.deleted, true, 'child could not delete its scratch CAL file');
  assert.ok(isAbsolute(parsed.folder), `resolved folder is not absolute: ${parsed.folder}`);
  return parsed.folder;
}

function readOrNull(p) {
  try { return readFileSync(p, 'utf8'); } catch (_) { return null; }
}

test.after(() => {
  for (const d of madeDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

test('preloaded child resolves a fixture CAL folder, not the user one', () => {
  const userFolder = fakeUserCalFolder();
  const folder = parseChild(runChild());

  assert.notEqual(resolve(folder), resolve(userFolder), 'child reused the user CAL folder');
  // Outside the fake user folder, in both directions.
  assert.equal(isInside(resolve(folder), resolve(userFolder)), false,
    `resolved folder is inside the fake user folder: ${folder}`);
  assert.equal(isInside(resolve(userFolder), resolve(folder)), false,
    `resolved folder contains the fake user folder: ${folder}`);

  // The canary is byte-for-byte untouched.
  assert.equal(readOrNull(join(userFolder, CANARY)), CANARY_BODY, 'user canary was modified');
  assert.equal(readOrNull(join(userFolder, 'MCP-other.CAL')), '; another user script\n');

  // The child's own directory is gone: it only ever created it, so it only
  // ever cleans up its own along with the owned root it created itself.
  assert.equal(existsSync(folder), false, `child left its fixture CAL folder behind: ${folder}`);
});

test('explicit test-owned fixture root survives child exit; child subdir is cleaned', () => {
  const userFolder = fakeUserCalFolder();
  const fixtureRoot = tempDir('cw-offline-cal-');
  const preRootContents = readdirSync(fixtureRoot);
  assert.deepEqual(preRootContents, []);

  const folder = parseChild(runChild({ env: { [ROOT_ENV]: fixtureRoot } }));
  assert.notEqual(resolve(folder), resolve(userFolder));

  // Child created its own subdirectory under the root the test owns...
  const rel = relative(resolve(fixtureRoot), resolve(folder));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `child escaped the fixture root: ${folder}`);
  assert.ok(rel.startsWith('process-'), `child fixture dir is not a process- dir: ${rel}`);

  // ...and removed it, while leaving the caller-provided root intact.
  assert.equal(existsSync(fixtureRoot), true, 'child deleted the caller-provided fixture root');
  assert.equal(existsSync(folder), false, `child left its subdirectory behind: ${folder}`);
  assert.deepEqual(readdirSync(fixtureRoot), []);

  assert.equal(readOrNull(join(userFolder, CANARY)), CANARY_BODY, 'user canary was modified');
});

test('untrusted inherited root is ignored and never deleted', () => {
  const userFolder = fakeUserCalFolder();
  const bogusRoots = tempDir('cw-not-owned-');
  const stray = join(bogusRoots, 'keep-me.txt');
  writeFileSync(stray, 'caller data\n', 'utf8');

  for (const bad of [userFolder, bogusRoots, '', 'relative/path', join(tmpdir(), 'no-such-cw-root')]) {
    const folder = parseChild(runChild({ env: { [ROOT_ENV]: bad } }));
    assert.notEqual(resolve(folder), resolve(userFolder));
    assert.equal(isInside(resolve(folder), resolve(userFolder)), false);
    assert.equal(isInside(resolve(folder), resolve(bogusRoots)), false,
      `child adopted an untrusted root for ${JSON.stringify(bad)}: ${folder}`);
    assert.equal(existsSync(folder), false);
  }

  assert.equal(readOrNull(join(userFolder, CANARY)), CANARY_BODY, 'user canary was modified');
  assert.equal(readOrNull(stray), 'caller data\n', 'untrusted caller directory was modified');
});

test('without the preload, the explicit override resolves verbatim (no registry read)', () => {
  const explicit = tempDir('cw-explicit-cal-');
  const canary = join(explicit, CANARY);
  writeFileSync(canary, CANARY_BODY, 'utf8');

  const result = runChild({ preload: false, env: { [CAL_ENV]: explicit } });
  const folder = parseChild(result);
  assert.equal(resolve(folder), resolve(explicit), 'override was not returned verbatim');
  // Verbatim means the child wrote and deleted inside the very folder we named.
  assert.equal(existsSync(explicit), true, 'explicit override folder disappeared');
  assert.equal(existsSync(canary), false, 'child did not operate inside the explicit folder');
  assert.deepEqual(readdirSync(explicit), []);
});

test('preload always overrides an inherited CAL folder value', () => {
  const userFolder = fakeUserCalFolder();
  const folder = parseChild(runChild({ env: { [CAL_ENV]: userFolder } }));

  assert.notEqual(resolve(folder), resolve(userFolder), 'inherited CAL folder leaked into the child');
  assert.equal(isInside(resolve(folder), resolve(userFolder)), false);
  assert.equal(readOrNull(join(userFolder, CANARY)), CANARY_BODY, 'user canary was modified');

  // A relative override is not a trustworthy folder; the preload replaces it.
  const relative = parseChild(runChild({ env: { [CAL_ENV]: 'relative/cal' } }));
  assert.ok(isAbsolute(relative));
  assert.equal(isInside(resolve(relative), resolve(userFolder)), false);
});

// Regression: fixture creation failure used to leave the override unset, so
// lib/sonar.js fell through to the real CAL folder. It must now fail closed,
// before the shims are patched and before anything imports lib/sonar.js.
test('preload fails closed when fixture creation fails (real sonar never imported)', () => {
  const userFolder = fakeUserCalFolder();
  const marker = 'cw-fail-closed-probe:' + process.pid;
  // Patch fs.mkdtempSync to fail, then require the preloader, then import
  // lib/sonar.js. The preloader must exit before the import can run.
  const script = `
const fs = require('node:fs');
fs.mkdtempSync = () => { throw new Error('simulated ENOSPC'); };
require(${JSON.stringify(PRELOAD)});
import(${JSON.stringify(SONAR_URL)}).then((m) => {
  let folder = '<import-failed>';
  try { folder = m.calFolder(); } catch (_) {}
  process.stdout.write(${JSON.stringify(marker)} + ' ' + JSON.stringify({ folder }) + '\\n');
}).catch((e) => {
  process.stdout.write(${JSON.stringify(marker)} + ' ' + JSON.stringify({ importError: String(e) }) + '\\n');
});
`;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 25000,
    env: { ...process.env, NODE_OPTIONS: '', [CAL_ENV]: userFolder, [ROOT_ENV]: '' },
  });
  if (child.error) throw child.error;

  assert.notEqual(child.status, 0, 'preload did not fail closed: ' + (child.stdout || ''));
  assert.equal((child.stdout || '').includes(marker), false,
    'lib/sonar.js was imported despite the fixture failure: ' + child.stdout);
  assert.match(child.stderr || '', /isolated CAL folder/,
    'missing fail-closed diagnostic: ' + child.stderr);
  assert.equal(readOrNull(join(userFolder, CANARY)), CANARY_BODY, 'user canary was modified');
  assert.equal(readOrNull(join(userFolder, 'MCP-other.CAL')), '; another user script\n');
  assert.deepEqual(readdirSync(userFolder).sort(), [CANARY, 'MCP-other.CAL'].sort());
});
