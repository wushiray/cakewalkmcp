import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UI_RECIPE } from '../lib/commands.js';
import { COMMAND_EVIDENCE } from '../lib/verify.js';

test('command evidence has one authoritative entry per WM_COMMAND id', () => {
  assert.equal(new Set(COMMAND_EVIDENCE.map(c => c.cmdId)).size, COMMAND_EVIDENCE.length);
});
test('UIA mouse guidance preserves physical screen coordinates', () => {
  assert.match(UI_RECIPE.coordinateSpace.detail, /physical screen pixels/);
  assert.match(UI_RECIPE.coordinateSpace.detail, /no scaling/);
});
test('layout-only inventory excludes names already known without CLSIDs and duplicate layout IDs', () => {
  const s = readFileSync(new URL('../lib/plugins.js', import.meta.url), 'utf8');
  const start = s.indexOf('export function layoutOnlyPlugins');
  const end = s.indexOf('\n}\n', start) + 2;
  const inv = [{ name: 'Synth', clsid: null }];
  inv.scannedOnly = ['C:/VST/Boost11_64.dll'];
  const layout = [{ name: 'synth', clsid: '{A}' }, { name: 'Boost11', clsid: '{B}' },
    { name: 'Other', clsid: '{C}' }, { name: 'Other alias', clsid: '{C}' }];
  const fn = new Function('loadInventory', 'loadLayout', 'guessKind',
    s.slice(start, end).replace('export ', '') + ';return layoutOnlyPlugins;')(
      () => inv, () => layout, () => 'effect');
  assert.deepEqual(fn('').map(p => p.name), ['Other']);
});
test('unsupported node:sqlite reports a coded compatibility error', () => {
  const s = readFileSync(new URL('../lib/menu.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = s.indexOf('export function loadCommandIndex');
  const end = s.indexOf('\n}\n', start) + 2;
  const fn = new Function('commandIndexPath', 'require', 'let indexCache=null;'
    + s.slice(start, end).replace('export ', '') + ';return loadCommandIndex;')(
      () => 'fixture/cwsearch.dat', () => { throw new Error('no node:sqlite'); });
  assert.throws(fn, e => e.code === 'COMMAND_INDEX_UNSUPPORTED');
});
