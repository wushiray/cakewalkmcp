// Executable no-host check for Get-DialogRoot (native/uia/cw_uia.ps1).
//
// The real host evidence: the 导入音轨模板 dialog is a #32770 window OWNED by
// the SONAR main window, so a search of desktop Children alone says "not open"
// while the dialog is on screen. The fixture extracts the actual Get-DialogRoot
// body from the product AST and runs it against C# stub automation types — no
// SONAR, no desktop, no UIAutomationClient. This test only spawns it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = path.join(here, 'fixtures', 'template-dialog.ps1');
const source = path.join(root, 'native', 'uia', 'cw_uia.ps1');

test(
  'Get-DialogRoot finds an owned #32770 dialog without a host',
  { skip: process.platform !== 'win32' && 'powershell fixture needs Windows' },
  () => {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-SourcePath', source],
      { encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
    assert.equal(r.status, 0, `fixture failed: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    assert.equal(out.ok, true, JSON.stringify(out));
  },
);
