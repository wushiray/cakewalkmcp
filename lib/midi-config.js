// lib/midi-config.js — read and write SONAR's MIDI port enablement.
//
// SONAR keeps which MIDI ports are enabled in %APPDATA%\Cakewalk\Sonar\TTSSEQ.INI,
// not in the registry and not in the project file. Verified on 32.10.0.021 —
// after ticking "Studio One AI Notes" in Preferences > MIDI > Devices the file
// read:
//
//   [MIDI Input Devices]
//   0=Steinberg UR22C-1
//   1=Studio One AI Notes
//   MaxInPort=1
//
// That makes the one-time setup the README used to describe as "only the user
// can do it" scriptable: we can read the enabled set, add a port, and write the
// file back. It also gives us a way to *verify* the setup without a UI, which
// the MIDI send path alone could never do.
//
// SONAR reads this file at startup and when the Devices dialog is applied, so a
// change here lands on the next SONAR start (or after the dialog is opened and
// confirmed). We say so in the result rather than implying it is live.

import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decodeIni, encodeIni } from './ini-codec.js';

export const SECTIONS = {
  input: 'MIDI Input Devices',
  output: 'MIDI Output Devices',
  echo: 'MIDI Echo Devices',
};

const MAXKEY = { input: 'MaxInPort', output: 'MaxOutPort', echo: 'MaxEchoPort' };

export function configPath() {
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const candidates = [
    join(appdata, 'Cakewalk', 'Sonar', 'TTSSEQ.INI'),
    join(appdata, 'Cakewalk', 'SONAR', 'TTSSEQ.INI'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0];
}


/**
 * SONAR writes TTSSEQ.INI in the system ANSI code page on most installs, but a
 * UTF-16 file (with a BOM) is legal and did occur in the wild. Reading it as
 * UTF-8 yielded NUL-separated text and found no ports at all, silently.
 */
// Encoding-aware INI I/O lives in ./ini-codec.js, so that a legacy ANSI file is
// decoded AND re-encoded in the same code page and a UTF-8 BOM survives a write.
function readIni(path) {
  return decodeIni(readFileSync(path));
}

// Encoding happens at the call site, before the backup, so that a name the
// file's code page cannot represent fails without touching the original.
function writeIni(path, bytes) {
  writeFileSync(path, bytes);
}

/**
 * Parse the INI into { input: [...names], output: [...], echo: [...] }.
 * Missing file yields empty lists rather than throwing — the transport can
 * still be probed from the Windows device list.
 */
export function readConfig() {
  const path = configPath();
  const out = { path, exists: false, input: [], output: [], echo: [] };
  if (!existsSync(path)) return out;
  out.exists = true;
  const { text } = readIni(path);
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      const name = m[1].trim();
      section = Object.entries(SECTIONS).find(([, v]) => v === name)?.[0] || null;
      continue;
    }
    if (!section) continue;
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    // Indexed entries ("0=Name") are devices; Max*Port is a count, not a name.
    if (/^\d+$/.test(key) && value) out[section].push(value);
  }
  return out;
}

/**
 * Add a port name to a section, preserving the rest of the file. Idempotent:
 * returns changed:false when the name is already enabled.
 *
 * Writes a .bak next to the file before the first modification, because SONAR
 * overwrites this file whenever its Devices dialog is applied and a botched
 * edit would otherwise be unrecoverable.
 */
export function enablePort(name, { section = 'input', backup = true } = {}) {
  const path = configPath();
  const want = SECTIONS[section];
  if (!want) {
    const e = new Error(`unknown section '${section}'; expected input, output or echo`);
    e.code = 'BAD_SECTION';
    throw e;
  }
  if (!existsSync(path)) {
    const e = new Error(`SONAR MIDI config not found at ${path}. Start SONAR once so it writes the file.`);
    e.code = 'NO_CONFIG';
    throw e;
  }

  // Reject values that would break the line format. A CR/LF splits the entry
  // into two lines, which the audit used to inject a second MaxInPort and a
  // whole new section; '[' at the start of a line is what starts a section.
  // U+2028/U+2029 are line terminators to JS regexes, so a CR/LF-only
  // filter let them smuggle a second line into the INI.
  const cleanName = String(name).replace(/[\r\n\u2028\u2029\0]+/g, ' ').trim();
  if (!cleanName) {
    const e = new Error('port name is empty after trimming');
    e.code = 'BAD_PORT_NAME';
    throw e;
  }

  const { text: original, encoding } = readIni(path);
  const current = readConfig();
  if (current[section].some((n) => n.trim().toLowerCase() === cleanName.toLowerCase())) {
    return { ok: true, changed: false, reason: 'already enabled', section, port: cleanName, path };
  }

  const lines = original.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim() === `[${want}]`);
  if (headerIdx < 0) {
    const e = new Error(`section [${want}] not present in ${path}`);
    e.code = 'NO_SECTION';
    throw e;
  }

  // Work inside the section's own bounds. The old code scanned to the first
  // Max line (or to EOF when there was none), so indices from the NEXT section
  // leaked in and produced gaps like 0 and 2.
  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) { sectionEnd = i; break; }
  }

  // Rebuild the section instead of splicing around it. Splicing required
  // adjusting every remembered index, and the audit found that when a Max key
  // was not the LAST line the adjustment deleted a real device entry. A rebuild
  // cannot do that: entries are collected, renumbered densely, and written back
  // together with exactly one Max key.
  const maxRe = new RegExp(String.raw`^${MAXKEY[section]}\s*=\s*-?\d+\s*$`, 'i');
  const entries = [];
  const keep = [];
  for (let i = headerIdx + 1; i < sectionEnd; i++) {
    const t = lines[i].trim();
    const m = t.match(/^(\d+)\s*=\s*(.*)$/);
    if (m) { entries.push({ index: Number(m[1]), name: m[2] }); continue; }
    if (maxRe.test(t)) continue;            // dropped; exactly one is re-emitted
    if (t === '') continue;                 // blank lines are not worth preserving
    keep.push(lines[i]);
  }

  const dup = entries.findIndex((e) => e.name.trim().toLowerCase() === cleanName.toLowerCase());
  if (dup >= 0) {
    // A second check inside the section itself: readConfig trims, so a name with
    // a trailing space used to slip past and be appended twice.
    return { ok: true, changed: false, reason: 'already enabled', section, port: cleanName, path };
  }

  entries.push({ index: entries.length ? Math.max(...entries.map((e) => e.index)) + 1 : 0, name: cleanName });
  entries.sort((a, b) => a.index - b.index);

  const block = [
    ...keep,
    ...entries.map((e, i) => `${i}=${e.name}`),
    `${MAXKEY[section]}=${entries.length - 1}`,
  ];
  lines.splice(headerIdx + 1, sectionEnd - headerIdx - 1, ...block);

  // Encode BEFORE the backup and the write: a port name this file's encoding
  // cannot represent must fail with the original byte-for-byte untouched.
  const bytes = encodeIni(lines.join('\r\n'), encoding);

  if (backup) {
    const bak = `${path}.bak`;
    // Keep the FIRST backup: overwriting it on every edit destroys the pristine
    // copy exactly when it is needed. A backup that cannot be written must stop
    // the edit — the old code swallowed the failure and overwrote the config
    // anyway, so the user believed a backup existed when none did.
    if (existsSync(bak)) {
      // An existing .bak is kept as the pristine copy — but only if it is
      // actually a file. A DIRECTORY at that path is not a backup, and silently
      // skipping made the "protected" write unprotected.
      let isFile = false;
      try { isFile = statSync(bak).isFile(); } catch (_) { isFile = false; }
      if (!isFile) {
        const err = new Error(`${bak} exists but is not a file, so no backup can be kept; `
          + 'the configuration was NOT modified.');
        err.code = 'BACKUP_FAILED';
        throw err;
      }
    } else {
      try {
        copyFileSync(path, bak);
      } catch (e) {
        const err = new Error(`could not create the backup ${bak} (${e.message}); `
          + 'the configuration was NOT modified.');
        err.code = 'BACKUP_FAILED';
        throw err;
      }
    }
  }
  writeIni(path, bytes);

  return {
    ok: true,
    changed: true,
    section,
    port: cleanName,
    path,
    index: entries.length - 1,
    note: 'SONAR reads this file at startup and when the Devices dialog is applied; '
      + 'the change is not live in a running session until then.',
  };
}

/** Convenience: what a caller needs to know without the whole config. */
export function midiConfigSummary() {
  const c = readConfig();
  return {
    path: c.path,
    exists: c.exists,
    input: c.input,
    output: c.output,
    echo: c.echo,
  };
}
