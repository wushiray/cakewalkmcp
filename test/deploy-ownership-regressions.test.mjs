import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('installer restarts only its owned loopMIDI instance and never a shared or reused PID', () => {
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',
    fileURLToPath(new URL('./fixtures/install-ownership.ps1',import.meta.url)),
    '-Source',fileURLToPath(new URL('../deploy/install.ps1',import.meta.url))],
    {encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(r.status,0,r.stderr+r.stdout);
  const cases=JSON.parse(r.stdout);
  for(const name of ['foreign','mixed','reused-id','untrusted']) {
    const c=cases.find(x=>x.case===name);
    assert.equal(c.result,false,name);
    assert.deepEqual(c.events,['warn'],name);
  }
  assert.deepEqual(cases.find(x=>x.case==='owned').events,['write','stop:20','start']);
  assert.deepEqual(cases.find(x=>x.case==='none').events,['write','start']);
  assert.deepEqual(cases.find(x=>x.case==='existing').events,[]);
});

test('installer releases its lock through the real AST finally block', () => {
  const source=fileURLToPath(new URL('../deploy/install.ps1',import.meta.url));
  const code=`$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile('${source.replace(/'/g,"''")}',[ref]$t,[ref]$e);if($e.Count){exit 2};$x=$a.Find({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $n.Finally -and $n.Finally.Extent.Text -match 'Exit-InstallerLock'},$false);if(-not $x){exit 3};if($a.Extent.Text.IndexOf('Enter-InstallerLock') -gt $a.Extent.Text.IndexOf('Step 1')){exit 4}`;
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,r.stderr);
  assert.match(readFileSync(new URL('../deploy/install-lock.ps1',import.meta.url),'utf8'),/WaitOne\(0\)/);
});

test('launch trust rejects a bad signature, another publisher, and signature lookup failure', () => {
  const source=fileURLToPath(new URL('../deploy/install.ps1',import.meta.url));
  const code=`$ErrorActionPreference='Stop';$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile('${source.replace(/'/g,"''")}',[ref]$t,[ref]$e);$f=$a.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-LoopMidiExecutable'},$true);Invoke-Expression $f.Extent.Text;function Get-AuthenticodeSignature {param($LiteralPath,$ErrorAction) if($script:fail){throw 'fixture failure'};return $script:sig};$r=@();foreach($item in @(@('Valid','CN=Tobias Erichsen, O=Vendor'),@('NotSigned','CN=Tobias Erichsen'),@('Valid','CN=Other Publisher'))){$script:sig=[pscustomobject]@{Status=$item[0];SignerCertificate=[pscustomobject]@{Subject=$item[1]}};$r+=(Test-LoopMidiExecutable 'fixture.exe')};$script:fail=$true;$r+=(Test-LoopMidiExecutable 'fixture.exe');ConvertTo-Json -Compress -InputObject $r`;
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout),[true,false,false,false]);
});
