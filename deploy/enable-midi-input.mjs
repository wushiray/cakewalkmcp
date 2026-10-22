// deploy/enable-midi-input.mjs — enable one MIDI input device in SONAR's config.
//
// Reuses lib/midi-config.js rather than reimplementing TTSSEQ.INI handling in
// PowerShell: enablePort is the code that was fixed and tested against a
// pristine file, an already-configured file and a duplicate-Max file. The
// installer only needs to pass it a device name.
//
// If the file does not exist yet (SONAR has never had its MIDI Devices dialog
// applied), a minimal one is created first. That is the state a fresh install is
// in, and it is exactly the shape enablePort was tested against:
//
//     [MIDI Input Devices]
//     MaxInPort=-1
//     ...
//
// MaxInPort=-1 is the pristine "nothing enabled" value, NOT "all devices" — the
// key holds the highest enabled index. enablePort maintains it correctly.
import { existsSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath, enablePort } from '../lib/midi-config.js';

const name = process.argv[2];
if (!name) {
  console.log(JSON.stringify({ ok: false, error: 'usage: enable-midi-input.mjs <device name>' }));
  process.exit(0);
}

const path = configPath();
if (!path) {
  console.log(JSON.stringify({ ok: false, error: 'could not resolve the TTSSEQ.INI path' }));
  process.exit(0);
}

// A machine where SONAR has never run has no Cakewalk\Sonar directory at all;
// writing the file would fail with ENOENT and read as "could not enable".
mkdirSync(dirname(path), { recursive: true });

const created = !existsSync(path);
if (created) {
  writeFileSync(
    path,
    '[MIDI Input Devices]\r\nMaxInPort=-1\r\n'
    + '[MIDI Output Devices]\r\nMaxOutPort=-1\r\n'
    + '[MIDI Echo Devices]\r\nMaxEchoPort=-1\r\n',
    'utf8',
  );
} else {
  try { copyFileSync(path, `${path}.mcp.bak`); } catch { /* best effort */ }
}

try {
  const r = enablePort(name, { section: 'input' });
  console.log(JSON.stringify({ ...r, createdFile: created }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message, code: e.code, createdFile: created }));
}
process.exit(0);
