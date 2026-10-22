// Audit 2026-10-22: INI encoding round-trips.
//
// Scope is deliberately narrow and hermetic: APPDATA points at a tmp dir and
// CW_INI_ANSI_CODEPAGE fixes the legacy code page to 936 (GBK) so the test does
// not depend on the host's locale. No real %APPDATA%, no SONAR, no native host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeIni, encodeIni } from '../lib/ini-codec.js';
import { enablePort, readConfig } from '../lib/midi-config.js';

const IS_WIN = process.platform === 'win32';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sonar-ini-'));
  const prevAppData = process.env.APPDATA;
  const prevCp = process.env.CW_INI_ANSI_CODEPAGE;
  process.env.APPDATA = dir;
  process.env.CW_INI_ANSI_CODEPAGE = '936';
  const iniDir = join(dir, 'Cakewalk', 'Sonar');
  const path = join(iniDir, 'TTSSEQ.INI');
  try {
    return fn({ dir, path, iniDir });
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    if (prevCp === undefined) delete process.env.CW_INI_ANSI_CODEPAGE; else process.env.CW_INI_ANSI_CODEPAGE = prevCp;
    rmSync(dir, { recursive: true, force: true });
  }
}

function seed({ iniDir, path }, bytes) {
  // mkdtemp is flat, so the Cakewalk/Sonar tree has to be created first.
  mkdirSync(iniDir, { recursive: true });
  writeFileSync(path, bytes);
}

test('BOM-less valid UTF-8 is preserved as UTF-8, BOM or not', () => {
  const plain = Buffer.from('[MIDI Input Devices]\r\n0=Ünïcode 録音\r\nMaxInPort=0\r\n', 'utf8');
  const d = decodeIni(plain);
  assert.equal(d.encoding, 'utf8');
  assert.deepEqual(encodeIni(d.text, d.encoding), plain);

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
  const b = decodeIni(bom);
  assert.equal(b.encoding, 'utf8-bom');
  assert.deepEqual(encodeIni(b.text, b.encoding), bom);
});

test('UTF-16LE and UTF-16BE with BOM are exact', () => {
  const text = '[MIDI Input Devices]\r\n0=Ünïcode 録音\r\nMaxInPort=0';
  for (const enc of ['utf16le', 'utf16be-bom']) {
    const bytes = encodeIni(text, enc);
    const d = decodeIni(bytes);
    assert.equal(d.encoding, enc);
    assert.equal(d.text, text);
    assert.deepEqual(encodeIni(d.text, d.encoding), bytes);
  }
});

test('GBK bytes survive: decode -> add a port -> re-encode in GBK', { skip: !IS_WIN && 'legacy code page needs Windows' }, () => withTmp((ctx) => {
  // 你好 in GBK is C4 E3 BA C3 — invalid UTF-8, so it must come back as legacy.
  const original = Buffer.concat([
    Buffer.from('[MIDI Input Devices]\r\n0=', 'ascii'),
    Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
    Buffer.from('\r\nMaxInPort=0\r\n', 'ascii'),
  ]);
  seed(ctx, original);

  const d = decodeIni(original);
  assert.match(d.encoding, /^legacy-ansi:/);
  assert.ok(d.text.includes('你好'));
  // Byte preservation + bake exact: no change must reproduce the input bytes.
  assert.deepEqual(encodeIni(d.text, d.encoding), original);

  const res = enablePort('Studio One AI Notes');
  assert.equal(res.changed, true);

  const after = readFileSync(ctx.path);
  // The original GBK name is still the same four bytes, still not UTF-8.
  assert.ok(after.includes(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])));
  assert.ok(after.includes(Buffer.from('1=Studio One AI Notes', 'ascii')));
  assert.ok(after.includes(Buffer.from('MaxInPort=1', 'ascii')));

  const back = decodeIni(after);
  assert.ok(back.text.includes('你好'));
  assert.ok(readConfig().input.includes('Studio One AI Notes'));
  assert.ok(existsSync(`${ctx.path}.bak`));
  assert.deepEqual(readFileSync(`${ctx.path}.bak`), original);

  // Idempotent: second call changes nothing, not even the bytes.
  const again = enablePort('Studio One AI Notes');
  assert.equal(again.changed, false);
  assert.deepEqual(readFileSync(ctx.path), after);
}));

test('unrepresentable port name leaves the original byte-exact', { skip: !IS_WIN && 'legacy code page needs Windows' }, () => withTmp((ctx) => {
  const original = Buffer.concat([
    Buffer.from('[MIDI Input Devices]\r\n0=', 'ascii'),
    Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
    Buffer.from('\r\nMaxInPort=0\r\n', 'ascii'),
  ]);
  seed(ctx, original);
  // 😀 has no GBK representation; the encode must fail before backup/write.
  assert.throws(() => enablePort('Port 😀'), (e) => ['LEGACY_CODEC_FAILED', 'UNREPRESENTABLE'].includes(e.code));
  assert.deepEqual(readFileSync(ctx.path), original);
  assert.equal(existsSync(`${ctx.path}.bak`), false);
}));

test('a BOM-less ASCII file is decoded as UTF-8 by documented policy', { skip: !IS_WIN && 'checks the ANSI path too' }, () => withTmp(() => {
  const ascii = Buffer.from('[MIDI Input Devices]\r\n0=Steinberg UR22C-1\r\nMaxInPort=0\r\n', 'ascii');
  const d = decodeIni(ascii);
  assert.equal(d.encoding, 'utf8');
  assert.deepEqual(encodeIni(d.text, d.encoding), ascii);
}));
