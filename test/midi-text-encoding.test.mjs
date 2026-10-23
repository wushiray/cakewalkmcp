// test/midi-text-encoding.test.mjs — the explicit track-name charset.
//
// An SMF track name is raw bytes with no charset tag, so the writer and reader
// take `textEncoding`. UTF-8 is the default and must stay byte-identical; GBK is
// what Chinese SONAR (code page 936) decodes, so a name written in GBK comes back
// as the original characters instead of mojibake. A character the code page has
// no slot for (an emoji) must fail before the destination file is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as M from '../lib/midi-file.js';

// 验收 — the two characters SONAR shows for this track name once it is GBK.
const NAME = '\u9a8c\u6536';
// The same name as CP936/GBK bytes, from Encoding.GetEncoding(936).
const GBK_BYTES = Buffer.from([0xd1, 0xe9, 0xca, 0xd5]);

/** A scratch directory torn down by the caller; only our own paths are removed. */
async function withDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-enc-'));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('gbk: write emits the CP936 bytes and read/describe decode them back', () => withDir((dir) => {
  const path = join(dir, 'gbk.mid');
  M.write(path, { tracks: [{ name: NAME, channel: 1, events: [] }], textEncoding: 'gbk' });

  const raw = readFileSync(path);
  assert.ok(raw.includes(GBK_BYTES), 'track name is stored as GBK D1E9 CAD5');

  // write() emits a conductor track first, so the named track is the second one.
  const names = M.read(path, { textEncoding: 'gbk' }).tracks.map((t) => t.name);
  assert.ok(names.includes(NAME), `read decoded the GBK name, got ${JSON.stringify(names)}`);
  const described = M.describe(path, { textEncoding: 'gbk' }).tracks.map((t) => t.name);
  assert.deepEqual(described, names, 'describe reuses read, so its names match');
}));

test('utf8 is the default and writes the same bytes as an explicit utf8', () => withDir((dir) => {
  const implicit = join(dir, 'implicit.mid');
  const explicit = join(dir, 'explicit.mid');
  const tracks = [{ name: NAME, channel: 1, events: [] }];
  M.write(implicit, { tracks });
  M.write(explicit, { tracks, textEncoding: 'utf8' });

  const a = readFileSync(implicit);
  const b = readFileSync(explicit);
  assert.ok(a.equals(b), 'default encoding is byte-identical to explicit utf8');
  assert.ok(!a.includes(GBK_BYTES), 'utf8 does not emit the GBK bytes');
  assert.ok(M.read(implicit).tracks.map((t) => t.name).includes(NAME), 'utf8 reads back exactly');
}));

test('an unknown textEncoding is rejected before an existing file is overwritten', () => withDir((dir) => {
  const path = join(dir, 'keep.mid');
  writeFileSync(path, 'do not touch');

  assert.throws(
    () => M.write(path, { tracks: [{ name: NAME, channel: 1, events: [] }], textEncoding: 'klingon' }),
    (e) => e instanceof Error && String(e.message).length > 0,
  );
  assert.throws(() => M.read(path, { textEncoding: 'klingon' }),
    (e) => e instanceof Error && String(e.message).length > 0);

  assert.equal(readFileSync(path, 'utf8'), 'do not touch', 'destination is unchanged');
}));

test('a name GBK cannot represent is refused and the destination is left alone', () => withDir((dir) => {
  const path = join(dir, 'emoji.mid');
  writeFileSync(path, 'previous contents');

  assert.throws(
    () => M.write(path, { tracks: [{ name: '\u{1f3b9}', channel: 1, events: [] }], textEncoding: 'gbk' }),
    (e) => e instanceof Error && String(e.message).length > 0,
  );
  assert.throws(() => M.buildTrack([], { channel: 1, name: '\u{1f3b9}', textEncoding: 'gbk' }),
    (e) => e instanceof Error && String(e.message).length > 0);

  assert.equal(readFileSync(path, 'utf8'), 'previous contents', 'destination is unchanged');
}));

test('the 1024-byte cap counts GBK-encoded name bytes', () => {
  // 512 two-byte GBK characters are exactly 1024 bytes: the largest name allowed.
  const fits = '\u9a8c'.repeat(512);
  const built = M.buildTrack([], { channel: 1, name: fits, textEncoding: 'gbk' });
  assert.ok(built.length > 0, 'a 1024-byte GBK name is accepted');

  assert.throws(
    () => M.buildTrack([], { channel: 1, name: fits + '\u9a8c', textEncoding: 'gbk' }),
    (e) => e instanceof Error && String(e.message).length > 0,
  );
});
