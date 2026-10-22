import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import * as midi from '../lib/midi-config.js';
import * as cal from '../lib/cal-script.js';

const root = mkdtempSync(join(tmpdir(), 'cw-config-release-'));
const originalAppdata = process.env.APPDATA;

test.after(() => {
  if (originalAppdata === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppdata;
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;

function ini(raw) {
  const app = join(root, 'app-' + seq++);
  const folder = join(app, 'Cakewalk', 'Sonar');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'TTSSEQ.INI');
  writeFileSync(path, raw);
  process.env.APPDATA = app;
  return path;
}

function utf16(text, be = false) {
  const body = Buffer.from(text, 'utf16le');
  if (be) body.swap16();
  return Buffer.concat([Buffer.from(be ? [254, 255] : [255, 254]), body]);
}

test('INI accepts second distinct port while preserving first backup', () => {
  const raw = Buffer.from('[MIDI Input Devices]\r\nMaxInPort=-1\r\n');
  const p = ini(raw);
  midi.enablePort('RC21 A');
  midi.enablePort('RC21 B');
  assert.deepEqual(midi.readConfig().input, ['RC21 A', 'RC21 B']);
  assert.deepEqual(readFileSync(p + '.bak'), raw);
});

for (const be of [false, true]) {
  test('INI preserves UTF16 ' + (be ? 'BE' : 'LE') + ' on write', () => {
    const p = ini(utf16('[MIDI Input Devices]\r\n0=原有端口\r\nMaxInPort=0\r\n', be));
    midi.enablePort('RC21 New', { backup: false });
    assert.deepEqual([...readFileSync(p).subarray(0, 2)], be ? [254, 255] : [255, 254]);
    assert.deepEqual(midi.readConfig().input, ['原有端口', 'RC21 New']);
  });
}

test('CAL backup failure never overwrites source', () => {
  const folder = join(root, 'cal-fail');
  mkdirSync(folder);
  const p = join(folder, 'RC21.CAL');
  writeFileSync(p, 'old-source\n');
  mkdirSync(p + '.bak');
  assert.throws(
    () => cal.writeScript('RC21.CAL', 'new-source', { folder }),
    (e) => e.code === 'BACKUP_FAILED'
  );
  assert.equal(readFileSync(p, 'utf8'), 'old-source\n');
});

test('CAL keeps first backup across multiple updates', () => {
  const folder = join(root, 'cal-sequence');
  mkdirSync(folder);
  const p = join(folder, 'RC21.CAL');
  writeFileSync(p, 'original\n');
  cal.writeScript('RC21.CAL', 'second', { folder });
  cal.writeScript('RC21.CAL', 'third', { folder });
  assert.equal(readFileSync(p + '.bak', 'utf8'), 'original\n');
  assert.equal(readFileSync(p, 'utf8'), 'third\n');
});

test('CAL stat failure has BACKUP_FAILED and leaves source unchanged', () => {
  const folder = join(root, 'cal-stat');
  mkdirSync(folder);
  const p = join(folder, 'RC21.CAL');
  writeFileSync(p, 'original\n');
  writeFileSync(p + '.bak', 'first\n');
  const oldStat = fs.statSync;
  fs.statSync = (path, ...args) => {
    if (String(path) === p + '.bak') {
      throw Object.assign(new Error('injected stat access failure'), { code: 'EACCES' });
    }
    return oldStat(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => cal.writeScript('RC21.CAL', 'next', { folder }),
      (e) => e.code === 'BACKUP_FAILED'
    );
    assert.equal(readFileSync(p, 'utf8'), 'original\n');
  } finally {
    fs.statSync = oldStat;
    syncBuiltinESMExports();
  }
});
