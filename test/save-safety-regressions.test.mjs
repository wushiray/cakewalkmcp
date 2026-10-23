import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyTitle } from '../lib/track-ui.js';
import { saveStateFromDocument } from '../lib/project.js';

const unsafe = [
  ['song.mid* - Cakewalk Sonar', 'song.mid'],
  ['Cakewalk Sonar - [song.cwp*]', 'song.cwp'],
  ['song.mid - Cakewalk Sonar', 'other.mid'],
  ['Cakewalk Sonar - [song.cwp]', 'other.cwp'],
  ['Cakewalk Sonar - [song.mid]', null],
  ['Cakewalk Sonar - [song.cwp]', null],
  ['song.mid - Cakewalk Sonar', null],
  ['unexpected caption', null],
  ['Cakewalk Sonar', 'song.mid*'],
];
for (const [title, tab] of unsafe) {
  test(`close safety refuses contradictory/missing evidence: ${title} / ${tab}`, () => {
    const state = saveStateFromDocument(classifyTitle(title, tab));
    assert.equal(state.safeToClose, false, JSON.stringify(state));
  });
}
for (const title of ['song.mid* - Cakewalk Sonar', 'Cakewalk Sonar - [song.cwp*]']) {
  test(`positive dirty evidence cannot be erased: ${title}`, () => {
    const tab = title.startsWith('song.mid') ? 'song.mid' : 'song.cwp';
    const state = classifyTitle(title, tab);
    assert.equal(state.modified, true);
    assert.equal(state.modifiedKnown, true);
  });
}
test('matching clean tab and canonical empty frame remain distinguishable', () => {
  for (const [title, tab] of [
    ['song.mid - Cakewalk Sonar', 'song.mid'],
    ['Cakewalk Sonar - [song.cwp]', 'song.cwp'],
    ['Cakewalk Sonar', null],
  ]) assert.equal(saveStateFromDocument(classifyTitle(title, tab)).safeToClose, true);
});
test('explicitly unknown or malformed document state is never safe', () => {
  for (const doc of [null, {}, { known:false }, { known:true, projectOpen:null },
    { known:true, projectOpen:true, modified:false, modifiedKnown:false }]) {
    assert.equal(saveStateFromDocument(doc).safeToClose, false, JSON.stringify(doc));
  }
});
test('actual PowerShell overlay branch counts observed disappearance, not posted messages', () => {
  const r = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-File',
    fileURLToPath(new URL('./fixtures/overlay-result.ps1', import.meta.url)),
    '-Source', fileURLToPath(new URL('../bridge/agent.js', import.meta.url))],
    {encoding:'utf8', windowsHide:true, timeout:20000});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const cases = JSON.parse(r.stdout);
  for (const name of ['protected', 'post-failed', 'refused', 'nothing']) {
    const c=cases.find(x=>x.name===name);
    assert.equal(c.result.closed, false, name);
    assert.equal(c.result.closedCount, 0, name);
  }
  const partial=cases.find(x=>x.name==='partial').result;
  assert.equal(partial.closed, true);
  assert.equal(partial.closedCount, 1);
  assert.equal(partial.overlays.length, 1);
  const all=cases.find(x=>x.name==='all').result;
  assert.equal(all.closedCount, 2);
  assert.deepEqual(all.overlays, []);
});
