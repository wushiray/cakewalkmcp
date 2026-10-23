// test/cwp-caption-kind.test.mjs — caption-kind classification for document tabs.
//
// classifyTitle() is pure string work: given a frame caption and (optionally) the
// document tab label, it says whether a Cakewalk project is open, which document
// it is, and whether that document has unsaved changes (or whether that is even
// knowable). No host/bridge calls are involved.
//
// This suite does NOT import ../lib/track-ui.js. The function's source text is cut
// out of the real file and evaluated on its own, so the assertions stay pinned to
// the actual implementation without loading the host graph that module lives in.
// The source file must exist; if the export can no longer be cut out, this fails
// loudly rather than passing against a stale copy of the logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('../lib/track-ui.js', import.meta.url));

function loadExportedFunction(modulePath, name) {
  const source = readFileSync(modulePath, 'utf8');
  const start = source.indexOf(`export function ${name}`);
  assert.notEqual(start, -1, `expected \`export function ${name}\` in ${modulePath}`);
  const close = source.slice(start).search(/\r?\n\}\r?\n/);
  assert.notEqual(close, -1, `could not find the end of \`export function ${name}\``);
  const end = start + close + (source[start + close] === '\r' ? 4 : 2);
  assert.ok(end > start + 1, `could not find the end of \`export function ${name}\``);
  const fn = source.slice(start, end).replace(`export function ${name}`, `function ${name}`);
  return new Function(`${fn};return ${name};`)();
}

const classifyTitle = loadExportedFunction(sourcePath, 'classifyTitle');

test('a clean .cwp caption with its matching tab is a clean project', () => {
  const result = classifyTitle('fresh.cwp - Cakewalk Sonar', 'fresh.cwp');
  assert.equal(result.documentKind, 'cakewalk-project');
  assert.equal(result.project, 'fresh.cwp');
  assert.equal(result.projectOpen, true);
  assert.equal(result.modified, false);
  assert.equal(result.modifiedKnown, true);
});

test('a dirty matching tab makes the same caption modified', () => {
  const result = classifyTitle('fresh.cwp - Cakewalk Sonar', 'fresh.cwp*');
  assert.equal(result.project, 'fresh.cwp');
  assert.equal(result.modified, true);
  assert.equal(result.modifiedKnown, true);
});

test('no tab reading means modified is unknown, not clean', () => {
  const result = classifyTitle('fresh.cwp - Cakewalk Sonar');
  assert.equal(result.project, 'fresh.cwp');
  assert.equal(result.modified, null);
  assert.equal(result.modifiedKnown, false);
});

test('an imported MIDI document is not reported as a project', () => {
  const result = classifyTitle('x.mid - Cakewalk Sonar', 'x.mid');
  assert.equal(result.documentKind, 'imported');
  assert.equal(result.modified, false);
});

test('the empty frame is a known caption with no project open', () => {
  const result = classifyTitle('Cakewalk Sonar');
  assert.equal(result.known, true);
  assert.equal(result.projectOpen, false);
});
