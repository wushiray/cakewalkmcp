// test/parsers.test.mjs — the string-format parsers.
//
// This layer earns its keep because every one of these parsers reads an external
// format that no test can regenerate: a `reg query` dump, an INI file, an XML
// menu layout. Each was reverse-engineered by inspection, so each has assumptions
// worth pinning — particularly that a subkey name can contain '/', spaces, '*' and
// a Windows path, which is exactly where a naive split breaks.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseInventoryKeyNames, parseInventoryRegQuery } from '../lib/plugins.js';
import { classifyTitle, trackAccessReadiness } from '../lib/track-ui.js';
import { SAMPLE_INVENTORY_KEYNAMES, SAMPLE_CLSID_QUERY } from './helpers.mjs';

// This suite is deliberately process-free: the liveness check that used to wait
// on the bridge has moved to integration.test.mjs.

// --- plugin inventory --------------------------------------------------------

test('parseInventoryKeyNames picks up named entries only', () => {
  const inv = parseInventoryKeyNames(SAMPLE_INVENTORY_KEYNAMES);
  const names = inv.map((p) => p.name).sort();
  assert.deepEqual(names, ['2B Crushed', 'EZdrummer 3', 'UADx Pultec EQP-1A EQ']);
});

test('parseInventoryKeyNames keeps the file path and index separate from the name', () => {
  const inv = parseInventoryKeyNames(SAMPLE_INVENTORY_KEYNAMES);
  const crushed = inv.find((p) => p.name === '2B Crushed');
  assert.equal(crushed.index, 0);
  assert.equal(crushed.file, 'c:/program files/common files/VST3/2B Crushed/2B Crushed.vst3');
});

test('parseInventoryKeyNames separates unnamed files from named plugins', () => {
  const inv = parseInventoryKeyNames(SAMPLE_INVENTORY_KEYNAMES);
  // A DLL with no "*<idx> <name>" suffix is scanned but not exposed as a plugin.
  assert.equal(inv.find((p) => p.name === 'Boost11'), undefined);
  assert.ok(inv.scannedOnly.some((f) => /Boost11_64\.dll$/.test(f)),
    'the unnamed Boost11 DLL should land in scannedOnly');
  assert.ok(inv.scannedOnly.some((f) => /SI-Drum Kit\.dll$/.test(f)),
    'the bundled SI instruments land there too');
});

test('parseInventoryKeyNames handles a name containing spaces', () => {
  const inv = parseInventoryKeyNames(SAMPLE_INVENTORY_KEYNAMES);
  assert.ok(inv.some((p) => p.name === 'UADx Pultec EQP-1A EQ'));
});

test('parseInventoryKeyNames handles an index greater than 9', () => {
  const inv = parseInventoryKeyNames(SAMPLE_INVENTORY_KEYNAMES);
  const uad = inv.find((p) => p.name === 'UADx Pultec EQP-1A EQ');
  assert.equal(uad.index, 12);
});

test('parseInventoryKeyNames survives an empty or junk input', () => {
  // The result is an array with an extra `scannedOnly` property hanging off it,
  // so compare contents rather than using deepEqual against a bare [].
  for (const input of ['', 'not a registry dump', 'HKEY_CURRENT_USER\\...\\Inventory']) {
    const r = parseInventoryKeyNames(input);
    assert.equal(r.length, 0, `"${input.slice(0, 20)}" should yield no named plugins`);
    assert.deepEqual(r.scannedOnly, [], 'and no scanned files either');
  }
});

test('the scannedOnly side-channel is always present, as other code relies on it', () => {
  // loadInventory() reads this property without a guard, so the parser must
  // always attach it even when there is nothing to attach.
  const r = parseInventoryKeyNames(SAMPLE_INVENTORY_KEYNAMES);
  assert.ok(Array.isArray(r.scannedOnly), 'scannedOnly must be an array');
  assert.ok(r.scannedOnly.length > 0, 'the fixture has two unnamed DLLs');
});

test('parseInventoryKeyNames classifies instruments vs effects from the name', () => {
  const inv = parseInventoryKeyNames(SAMPLE_INVENTORY_KEYNAMES);
  assert.equal(inv.find((p) => p.name === 'EZdrummer 3').kind, 'instrument');
});

test('parseInventoryRegQuery reads the clsidPlug value', () => {
  const items = parseInventoryRegQuery(SAMPLE_CLSID_QUERY);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '2B Crushed');
  assert.equal(items[0].clsid, '{86FEB0B3-2BAA-4426-90AF-C6072DE284E5}');
});

test('parseInventoryRegQuery upper-cases the CLSID so lookups match', () => {
  const lower = SAMPLE_CLSID_QUERY.replace('{86FEB0B3', '{86feb0b3');
  const items = parseInventoryRegQuery(lower);
  assert.equal(items[0].clsid, items[0].clsid.toUpperCase());
});

test('parseInventoryRegQuery ignores a value line that belongs to no entry', () => {
  const orphan = '    clsidPlug    REG_SZ    {AAAA0000-0000-0000-0000-000000000000}\n';
  assert.deepEqual(parseInventoryRegQuery(orphan), []);
});

// --- layout ------------------------------------------------------------------

test('loadLayout parses folders, plugins and their CLSIDs from a fixture', async () => {
  const { loadLayout, layoutPath } = await import('../lib/plugins.js');
  // The real layout lives in AppData; if it is missing there is nothing to test.
  if (!layoutPath()) return;
  const layout = loadLayout();
  assert.ok(layout.length > 0, 'the real layout should have entries');
  for (const p of layout) {
    assert.ok(p.folder, 'every entry needs a folder');
    assert.match(p.clsid, /^\{[0-9A-F-]{36}\}$/, `bad clsid on ${p.name}`);
    assert.equal(typeof p.category, 'number');
  }
});

test('categoryOf finds the folder for a known CLSID and returns undefined otherwise', async () => {
  const { loadLayout, categoryOf } = await import('../lib/plugins.js');
  const layout = loadLayout();
  if (!layout.length) return;
  const sample = layout[0];
  assert.equal(categoryOf(sample.clsid), sample.folder);
  assert.equal(categoryOf('{00000000-0000-0000-0000-000000000000}'), undefined);
  assert.equal(categoryOf(null), undefined);
});

test('layoutOnlyPlugins finds the DX effects the VST inventory does not list', async () => {
  const { layoutOnlyPlugins } = await import('../lib/plugins.js');
  const all = layoutOnlyPlugins('', { limit: 500 });
  if (!all.length) return;   // nothing layout-only on this install
  for (const p of all) {
    assert.ok(p.clsid, 'layout-only entries carry a CLSID from the layout');
    assert.equal(p.source, 'menu-layout-only');
    assert.equal(p.present, null, 'no file to check, so presence is unknown not false');
  }
});

// --- MIDI config (TTSSEQ.INI) ------------------------------------------------

test('readConfig parses the three device sections and skips the Max keys', async () => {
  // readConfig reads a fixed path, so this test drives it through the parser by
  // reading the live file if present; the shape assertions hold either way.
  const { readConfig } = await import('../lib/midi-config.js');
  const c = readConfig();
  if (!c.exists) return;
  assert.ok(Array.isArray(c.input) && Array.isArray(c.output) && Array.isArray(c.echo));
  for (const list of [c.input, c.output, c.echo]) {
    for (const n of list) {
      assert.ok(!/^Max/.test(n), 'a Max*Port key must not be read as a device name');
      assert.equal(typeof n, 'string');
      assert.ok(n.length > 0);
    }
  }
});

test('SECTIONS maps the three kinds to SONAR section names', async () => {
  const { SECTIONS } = await import('../lib/midi-config.js');
  assert.equal(SECTIONS.input, 'MIDI Input Devices');
  assert.equal(SECTIONS.output, 'MIDI Output Devices');
  assert.equal(SECTIONS.echo, 'MIDI Echo Devices');
});

test('enablePort rejects an unknown section rather than writing nonsense', async () => {
  const { enablePort } = await import('../lib/midi-config.js');
  assert.throws(() => enablePort('X', { section: 'nowhere' }), (e) => e.code === 'BAD_SECTION');
});

// --- menu / command index ----------------------------------------------------

test('flattenMenu turns a nested tree into paths and drops id-less nodes', async () => {
  const { flattenMenu } = await import('../lib/menu.js');
  const tree = [
    { label: '文件(&F)', cmdId: null, children: [
      { label: '新建(&N)...', cmdId: 32947, cmdHex: '0x80B3' },
      { label: '(separator)', cmdId: 0 },
    ]},
  ];
  const flat = flattenMenu(tree);
  assert.equal(flat.length, 2, 'both entries have an id, including the separator');
  assert.equal(flat[0].path, '文件 > 新建...');
  assert.equal(flat[0].cmdId, 32947);
});

test('flattenMenu strips accelerators so a path can be matched by a plain string', async () => {
  const { flattenMenu } = await import('../lib/menu.js');
  const flat = flattenMenu([{ label: '编辑(&E)', cmdId: null, children: [
    { label: '参数设置(&P)...', cmdId: 34861 },
  ]}]);
  assert.equal(flat[0].path, '编辑 > 参数设置...');
  assert.ok(!flat[0].path.includes('&'), 'no ampersand should survive');
});

test('flattenMenu tolerates a null tree (ConvertTo-Json emits null for an empty array)', async () => {
  const { flattenMenu } = await import('../lib/menu.js');
  assert.deepEqual(flattenMenu(null), []);
  assert.deepEqual(flattenMenu(undefined), []);
});

// --- document state ----------------------------------------------------------

/*
 * The documentState() liveness test used to live here and waited up to 25 s on
 * the PowerShell bridge. It was the single reason this file took 25 seconds
 * instead of a quarter of one, and the comment it carried said so ("the one
 * parser test with a real timeout risk") — which is a smell, not a justification.
 *
 * The property it checked is real: documentState must answer rather than hang.
 * But that is a property of the INTEGRATION between this package and the bridge,
 * not of the parsers, and testing it here made every run pay for it while also
 * making this suite depend on whether SONAR happened to be running.
 *
 * It now lives in integration.test.mjs, where waiting on a process is the point.
 */

test('the title classification handles both shapes SONAR produces', () => {
  const cases = [
    ['Cakewalk Sonar', { known: true, projectOpen: false }],
    ['Cakewalk Sonar - [song.cwp]', { known: true, projectOpen: true, project: 'song.cwp' }],
    ['Cakewalk Sonar - [song.cwp*]', { known: true, projectOpen: true, modified: true }],
    ['song.mid - Cakewalk Sonar', { known: true, projectOpen: true, project: 'song.mid' }],
  ];
  for (const [title, want] of cases) {
    const got = classifyTitle(title);
    assert.equal(got.known, want.known, `${title}: known`);
    assert.equal(got.projectOpen, want.projectOpen, `${title}: projectOpen`);
    if (want.project) assert.equal(got.project, want.project, `${title}: project`);
    if (want.modified !== undefined) assert.equal(got.modified, want.modified, `${title}: modified`);
  }
});

test('the document tab is authoritative for the dirty flag', () => {
  // Measured on SONAR 2026.10 with an imported MIDI: the frame caption is
  // "release-host.mid - Cakewalk Sonar" with no asterisk, while the document
  // tab child window is "release-host.mid*". Reading only the caption reported
  // modified:false / safeToClose:true for a project with unsaved changes.
  const dirty = classifyTitle('release-host.mid - Cakewalk Sonar', 'release-host.mid*');
  assert.equal(dirty.project, 'release-host.mid');
  assert.equal(dirty.modified, true);
  assert.equal(dirty.modifiedKnown, true);
  assert.equal(dirty.documentTab, 'release-host.mid*');

  const clean = classifyTitle('release-host.mid - Cakewalk Sonar', 'release-host.mid');
  assert.equal(clean.modified, false);
  assert.equal(clean.modifiedKnown, true);

  // No tab information: an imported document has never been saved as .cwp, so
  // "unknown" is the only honest answer — never false.
  const unknown = classifyTitle('release-host.mid - Cakewalk Sonar');
  assert.equal(unknown.modified, null);
  assert.equal(unknown.modifiedKnown, false);
  assert.equal(unknown.documentTab, null);

  // A dirty caption (older shapes) still wins when the tab is unavailable.
  const captionDirty = classifyTitle('release-host.mid* - Cakewalk Sonar');
  assert.equal(captionDirty.modified, true);
  assert.equal(captionDirty.project, 'release-host.mid');

  // For .cwp-shaped captions the tab also wins.
  const cwp = classifyTitle('Cakewalk Sonar - [song.cwp]', 'song.cwp*');
  assert.equal(cwp.modified, true);
});

test('track readiness is false when no strip controls are exposed', () => {
  const none = trackAccessReadiness([]);
  assert.equal(none.ready, false);
  assert.match(none.readyReason, /Free License|unactivated/);
  const failed = trackAccessReadiness([], 'uia failed');
  assert.equal(failed.ready, false);
  assert.equal(failed.visibleError, 'uia failed');
  const ok = trackAccessReadiness(['音量 on Track 1']);
  assert.equal(ok.ready, true);
  assert.equal(ok.readyReason, null);
  const notArray = trackAccessReadiness(null);
  assert.equal(notArray.ready, false);
});

test('the activation-state suffix does not hide an open project', () => {
  // Measured on a clean, unlicensed reinstall: SONAR appends its activation
  // state to the caption. The parser matched on a caption ENDING with the
  // product or document name, so "baseline.mid - Cakewalk Sonar [未激活]" read as
  // "no project open" — t5 stayed degraded and every track tool refused, on a
  // machine that had a project open the whole time.
  const cases = [
    ['Cakewalk Sonar [未激活]', false, null],
    ['browser.mid - Cakewalk Sonar [未激活]', true, 'browser.mid'],
    ['Cakewalk Sonar - [song.cwp] [未激活]', true, 'song.cwp'],
    ['Cakewalk Sonar - [song.cwp*] [未激活]', true, 'song.cwp'],
    ['Cakewalk Sonar [Not Activated]', false, null],
  ];
  for (const [title, open, project] of cases) {
    const got = classifyTitle(title);
    assert.equal(got.projectOpen, open, `${title}: projectOpen`);
    if (project) assert.equal(got.project, project, `${title}: project`);
    // The caption is reported as-is, marker included.
    assert.equal(got.title, title, `${title}: original caption preserved`);
  }
});

test('probePlan returns a surface list and steps for every topic', async () => {
  const { probePlan } = await import('../lib/project-state.js');
  for (const topic of ['overview', 'tracks', 'mixer', 'notes', 'selection', 'all']) {
    const p = probePlan(topic);
    assert.equal(p.topic, topic);
    assert.ok(p.surfaces.length > 0, `${topic} should name at least one surface`);
    assert.ok(p.steps.length > 0, `${topic} should give steps`);
    assert.ok(p.readable, 'the plan should state what is readable');
  }
});

test('probePlan guesses the topic from a natural-language word', async () => {
  const { probePlan } = await import('../lib/project-state.js');
  assert.equal(probePlan('notes').topic, 'notes');
  assert.equal(probePlan('音符').topic, 'notes');
  assert.equal(probePlan('nonsense').topic, 'overview');
  assert.equal(probePlan(undefined).topic, 'overview');
});

test('probePlan warning about the Event List appears only where it matters', async () => {
  const { probePlan } = await import('../lib/project-state.js');
  assert.ok(probePlan('notes').caveat, 'notes need the Event List, so say so');
  assert.equal(probePlan('tracks').caveat, undefined);
});
