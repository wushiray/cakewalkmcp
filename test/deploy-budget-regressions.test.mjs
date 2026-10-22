// Permanent regression suite promoted from the independently validated
// prototypes in .qa-handoff/env-budget-prototypes (written/executed by Codex).
//
// Each case spawns Windows PowerShell 5.1 on a fixture that:
//   * parses the (already fixed) deploy/install.ps1 with the AST parser,
//   * extracts ONLY the function definitions it needs via Invoke-Expression,
//   * stubs filesystem / network / process primitives (no real IO, no network,
//     no installer top-level execution),
//   * prints an ordered hashtable as pretty JSON, then enforces its own
//     exit-code assertions.
//
// The fixtures may emit source chatter (Write-Host) before the JSON, so stdout
// is reduced to the span from the first "{" to the last "}" before JSON.parse.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const routesFixture = path.join(testDir, 'fixtures', 'deploy-budget-routes.ps1');
const outputFixture = path.join(testDir, 'fixtures', 'deploy-budget-output.ps1');
const launchFixture = path.join(testDir, 'fixtures', 'deploy-budget-launch.ps1');

// Default: sibling ../deploy/install.ps1 relative to this test file.
// Optional override (process.argv[2]) -- not used by node:test itself, so it is
// read from the real command line supplied to a partial check run.
const defaultSource = path.resolve(testDir, '..', 'deploy', 'install.ps1');
const argvOverride = (() => {
  const idx = process.argv.indexOf('--source');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const positional = process.argv.slice(2).find(
    (a) => !a.startsWith('-') && /\.ps1$/i.test(a)
  );
  return positional || null;
})();
const sourcePath = path.resolve(argvOverride || defaultSource);

const FIXTURES = [routesFixture, outputFixture, launchFixture];

function runPowerShell(fixture, extraArgs) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fixture,
    '-Source',
    sourcePath,
    ...extraArgs,
  ];
  const res = spawnSync('powershell.exe', args, {
    windowsHide: true,
    timeout: 30000,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  let json = null;
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    json = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  }
  return {
    status: res.status,
    signal: res.signal,
    stdout,
    stderr,
    json,
    error: res.error,
  };
}

function runOk(fixture, extraArgs, label) {
  const r = runPowerShell(fixture, extraArgs);
  assert.equal(r.error, undefined, `${label}: spawn error: ${r.error && r.error.message}`);
  assert.equal(r.signal, null, `${label}: killed by signal ${r.signal}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.status, 0, `${label}: expected exit 0\n${r.stdout}\n${r.stderr}`);
  assert.notEqual(r.json, null, `${label}: no JSON payload on stdout\n${r.stdout}\n${r.stderr}`);
  return r.json;
}

// ---------------------------------------------------------------- prerequisites

test('deploy budget suite prerequisites exist', () => {
  assert.ok(fs.existsSync(sourcePath), `tested source not found: ${sourcePath}`);
  for (const f of FIXTURES) {
    assert.ok(fs.existsSync(f), `fixture not found: ${f}`);
    const text = fs.readFileSync(f, 'utf8');
    assert.match(text, /Management\.Automation\.Language/, `${f} must use AST parsing`);
    assert.doesNotMatch(text, /GetScriptBlock/, `${f} must not use nonexistent GetScriptBlock`);
    assert.match(text, /Parameter\(Mandatory=\$true\)\]\[string\]\$Source/, `${f} must require explicit -Source`);
  }
});

// ------------------------------------------------------------------- output

test('output: genuine install failure returns null, not a false success', () => {
  const json = runOk(outputFixture, [], 'output-failure');
  assert.equal(json.no_real_io, true, 'fixture must report no real IO');
  assert.equal(json.setupCalls, 1, 'exactly one bundled setup attempt');
  assert.equal(json.result, null, 'failure result must be null');
  assert.equal(json.truthy, false, 'failure result must not be truthy');
  assert.equal(json.expected_null, true, 'fixture confirms null result');
});

test('output: successful bundled install returns a single scalar-path object', () => {
  const json = runOk(outputFixture, ['-BundledSuccess'], 'output-success');
  assert.equal(json.no_real_io, true, 'fixture must report no real IO');
  assert.equal(json.setupCalls, 1, 'exactly one bundled setup attempt');
  assert.notEqual(json.result, null, 'success result must not be null');
  assert.equal(json.truthy, true, 'success result must be truthy');
  assert.equal(
    json.path,
    'C:\\qa-only-no-io\\loopMIDI.exe',
    'success path must be the bundled scalar path'
  );
});

// ------------------------------------------------------------------- routes

test('routes: bundled-exhausted budget stops after one bundled attempt', () => {
  const json = runOk(routesFixture, ['-Mode', 'bundled-exhausted'], 'routes-bundled');
  assert.equal(json.no_network_or_installer_executed, true, 'no real installer/network');
  assert.equal(json.lateDownloadCount, 0, 'no late download after budget exhaustion');
  const ops = (json.calls || []).map((c) => c.operation);
  assert.equal(ops.filter((o) => o === 'bundled').length, 1, 'exactly one bundled attempt');
  assert.equal(
    ops.filter((o) => o === 'download-after-expiry').length,
    0,
    'exhausted bundled route must not fall through to the next route'
  );
});

test('routes: pre-download expiry blocks the late download', () => {
  const json = runOk(routesFixture, ['-Mode', 'pre-download-expiry'], 'routes-pre-download');
  assert.equal(json.no_network_or_installer_executed, true, 'no real installer/network');
  assert.equal(json.lateDownloadCount, 0, 'no late download after expiry');
});

test('routes: winget lookup expiry blocks download and winget start', () => {
  const json = runOk(routesFixture, ['-Mode', 'winget-lookup-expiry'], 'routes-winget-lookup');
  assert.equal(json.no_network_or_installer_executed, true, 'no real installer/network');
  assert.equal(json.lateDownloadCount, 0, 'no late download after lookup expiry');
  const ops = (json.calls || []).map((c) => c.operation);
  assert.equal(
    ops.filter((o) => o === 'winget-start-after-lookup').length,
    0,
    'no winget start after lookup consumed the budget'
  );
});

test('routes: near expiry passes the actual remaining timeout (10s)', () => {
  const json = runOk(routesFixture, ['-Mode', 'near-expiry'], 'routes-near-expiry');
  assert.equal(json.no_network_or_installer_executed, true, 'no real installer/network');
  assert.equal(json.lateDownloadCount, 0, 'no late download with a short but valid budget');
  const downloads = (json.calls || []).filter((c) => c.operation === 'download-after-expiry');
  assert.equal(downloads.length, 1, 'exactly one attempted download');
  assert.equal(downloads[0].timeout, 10, 'download timeout must equal the remaining budget');
});

// ----------------------------------------------------------------- launcher

test('launcher: positive budget launches non-blocking process and kills it', () => {
  const json = runOk(launchFixture, ['-Budget', '2'], 'launch-budget-2');
  assert.equal(json.no_real_process, true, 'fixture must report no real process');
  const launches = json.launches || [];
  assert.ok(!launches.includes('synchronous-cmd'), 'must not shell out via synchronous cmd');
  assert.equal(launches.length, 1, 'exactly one non-blocking launch');
  assert.ok(json.elapsed <= json.budget + 3, `elapsed ${json.elapsed} exceeds budget ${json.budget}+3`);
  assert.deepEqual(json.killed, [777], 'the still-alive child must be killed');
});

test('launcher: zero budget never starts the setup', () => {
  const json = runOk(launchFixture, ['-Budget', '0'], 'launch-budget-0');
  assert.equal(json.no_real_process, true, 'fixture must report no real process');
  assert.ok(!(json.launches || []).includes('synchronous-cmd'), 'must not shell out via synchronous cmd');
  assert.equal((json.launches || []).length, 0, 'no launch allowed with a zero budget');
  assert.equal(json.elapsed, 0, 'no waiting with a zero budget');
  assert.equal(json.result, false, 'zero budget must report false');
});

test('launcher: negative budget never starts the setup', () => {
  const json = runOk(launchFixture, ['-Budget', '-5'], 'launch-budget-neg');
  assert.equal(json.no_real_process, true, 'fixture must report no real process');
  assert.ok(!(json.launches || []).includes('synchronous-cmd'), 'must not shell out via synchronous cmd');
  assert.equal((json.launches || []).length, 0, 'no launch allowed with a negative budget');
  assert.equal(json.elapsed, 0, 'no waiting with a negative budget');
  assert.equal(json.result, false, 'negative budget must report false');
});

test('launcher: already-exited child is not killed', () => {
  const json = runOk(launchFixture, ['-Budget', '2', '-AlreadyExited'], 'launch-already-exited');
  assert.equal(json.no_real_process, true, 'fixture must report no real process');
  const launches = json.launches || [];
  assert.ok(!launches.includes('synchronous-cmd'), 'must not shell out via synchronous cmd');
  assert.equal(launches.length, 1, 'exactly one non-blocking launch');
  assert.deepEqual(json.killed, [], 'an exited process must not be killed');
});
