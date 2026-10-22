// lib/ini-codec.js — decode/encode an INI byte buffer without losing its encoding.
//
// SONAR's TTSSEQ.INI is usually system-ANSI (a legacy Windows code page such as
// 936/GBK, 1252, 932 …), but UTF-8 (with or without a BOM) and UTF-16 (with a
// BOM) are legal. Decoding legacy bytes as UTF-8 silently mangles non-ASCII
// port names, and re-encoding as UTF-8 rewrites the whole file, so the codec
// records the exact source encoding and encodes back with the same one.
//
// Legacy single/multi-byte code pages are not implemented in JS (a table would
// be enormous and wrong); the platform converter is used instead — on Windows,
// PowerShell's .NET `Encoding.Default`, run through execFileSync with a fixed,
// unsalted -EncodedCommand. No text is ever interpolated into a command line.
//
// Policy for a *BOM-less* file whose bytes happen to be valid UTF-8: it is
// treated as UTF-8 and stays UTF-8 (round-trips exactly, and a user who saved a
// UTF-8 port name deliberately should not have it re-read as GBK). Caveat,
// documented for callers: an ASCII-only ANSI file is indistinguishable from
// UTF-8, so a later non-ASCII addition is encoded as UTF-8 rather than in the
// system ANSI code page. That is our deliberate choice: ASCII-only content is
// byte-identical either way, and inventing a code page for it would guess.
//
// Format of a legacy decode request/response over IPC: base64 in, base64 JSON
// out — never raw text, which a command line or argv would mangle.

import { execFileSync } from 'node:child_process';

const LEGACY = 'legacy-ansi';
const NON_WINDOWS = 'LEGACY_CODEPAGE_UNSUPPORTED';

// stdout of the child is base64(JSON) — pure ASCII, safe for any shell.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime
$req = [Console]::In.ReadToEnd()
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req)) | ConvertFrom-Json
$cp = [int]$req.cp
if ($cp -lt 1) { $cp = [int][Text.Encoding]::Default.CodePage }
$enc = [Text.Encoding]::GetEncoding($cp, [Text.EncoderFallback]::ExceptionFallback, [Text.DecoderFallback]::ExceptionFallback)
if ($req.op -eq 'decode') {
  $bytes = [Convert]::FromBase64String($req.data)
  $text = $enc.GetString($bytes)
} else {
  $bytes = $enc.GetBytes([string]$req.text)
  $back = $enc.GetString($bytes)
  if ($back -cne [string]$req.text) { throw 'roundtrip mismatch' }
  $text = [Convert]::ToBase64String($bytes)
}
$out = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject @{ ok = $true; cp = $cp; text = $text })))
[Console]::Out.Write($out)
`;

function codepage() {
  const raw = process.env.CW_INI_ANSI_CODEPAGE;
  if (raw === undefined || raw === '') return 0; // 0 => let .NET report its default
  if (!/^\d{1,5}$/.test(raw)) {
    const e = new Error(`CW_INI_ANSI_CODEPAGE must be a positive integer, got '${raw}'`);
    e.code = 'BAD_CODEPAGE';
    throw e;
  }
  const n = Number(raw);
  if (n < 1) {
    const e = new Error('CW_INI_ANSI_CODEPAGE must be a positive integer');
    e.code = 'BAD_CODEPAGE';
    throw e;
  }
  return n;
}

function invoke(op, payload) {
  if (process.platform !== 'win32') {
    const e = new Error('this file is not UTF-8 or BOM-tagged UTF-16, so it is in a legacy '
      + 'Windows code page; converting legacy code pages is only supported on Windows. '
      + 'The configuration was NOT modified.');
    e.code = NON_WINDOWS;
    throw e;
  }
  const cp = codepage();
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const req = Buffer.from(JSON.stringify({ op, cp, ...payload }), 'utf8').toString('base64');
  let out;
  try {
    out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        input: req,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        // A hung or wedged PowerShell must never block the MCP server forever:
        // execFileSync kills the child after this and we fail cleanly below.
        timeout: 15000,
      });
  } catch (e) {
    const err = new Error(`the legacy code page converter failed (${String(e.stderr || e.message).trim()}); `
      + 'the configuration was NOT modified.');
    err.code = 'LEGACY_CODEC_FAILED';
    throw err;
  }
  return JSON.parse(Buffer.from(String(out).trim(), 'base64').toString('utf8'));
}

function decodeLegacy(buf) {
  // Cheap reject: a legacy byte stream is never valid UTF-8 *and* BOM-tagged,
  // but we still let .NET be the judge of validity, not a JS table.
  const res = invoke('decode', { data: buf.toString('base64') });
  const text = String(res.text);
  // A decode is only trustworthy if the very same code page turns the text
  // back into the input bytes. If it does not, the source was not canonical
  // for this code page (stray bytes, over-long sequences, a mix of code
  // pages…). Returning the text would mean the next write silently rewrites
  // those bytes, so fail loudly and leave the file alone instead.
  const back = invoke('encode', { text, cp: res.cp });
  if (String(back.cp) !== String(res.cp)) {
    const e = new Error(`legacy code page mismatch while verifying the decode `
      + `(decoded as ${res.cp}, re-encoded as ${back.cp}); the configuration was NOT modified.`);
    e.code = 'LEGACY_CODEC_FAILED';
    throw e;
  }
  const bytes = Buffer.from(String(back.text), 'base64');
  if (!bytes.equals(buf)) {
    const e = new Error('the file is in a legacy code page but its bytes are not canonical '
      + `for code page ${res.cp}, so saving it back would rewrite them; `
      + 'the configuration was NOT modified.');
    e.code = 'NONCANONICAL_LEGACY_BYTES';
    throw e;
  }
  return { text, encoding: `${LEGACY}:${res.cp}` };
}

/** Bytes -> { text, encoding }. Encoding is what encodeIni needs to reproduce them. */
export function decodeIni(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) { body[i - 2] = buf[i + 1]; body[i - 1] = buf[i]; }
    return { text: body.toString('utf16le'), encoding: 'utf16be-bom' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const body = buf.subarray(3);
    // A UTF-8 BOM with invalid UTF-8 inside is corrupt, not legacy: fail loudly
    // instead of guessing a code page for it.
    const text = body.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(body)) {
      const e = new Error('file starts with a UTF-8 BOM but does not decode as valid UTF-8; '
        + 'the configuration was NOT modified.');
      e.code = 'CORRUPT_UTF8';
      throw e;
    }
    return { text, encoding: 'utf8-bom' };
  }
  const asUtf8 = buf.toString('utf8');
  if (Buffer.from(asUtf8, 'utf8').equals(buf)) return { text: asUtf8, encoding: 'utf8' };
  return decodeLegacy(buf);
}

function encodeUtf16Be(text) {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}

/** Text + encoding -> Buffer. Throws (touching nothing) if the text cannot be represented. */
export function encodeIni(text, encoding) {
  const s = String(text);
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  if (encoding === 'utf16be-bom') return encodeUtf16Be(s);
  if (encoding === 'utf8') {
    const body = Buffer.from(s, 'utf8');
    // Lone surrogates become U+FFFD; refuse rather than silently corrupt.
    if (body.toString('utf8') !== s) {
      const e = new Error(`the text contains characters UTF-8 cannot represent (unpaired surrogate); `
        + 'the configuration was NOT modified.');
      e.code = 'UNREPRESENTABLE';
      throw e;
    }
    return body;
  }
  if (encoding === 'utf8-bom') {
    const body = encodeIni(s, 'utf8');
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
  }
  const m = /^legacy-ansi:(\d{1,5})$/.exec(String(encoding || ''));
  if (!m) {
    const e = new Error(`unknown INI encoding '${encoding}'`);
    e.code = 'BAD_ENCODING';
    throw e;
  }
  const cp = Number(m[1]);
  if (!(cp > 0)) {
    const e = new Error(`invalid ANSI code page in encoding '${encoding}'`);
    e.code = 'BAD_ENCODING';
    throw e;
  }
  // The child validates twice: ExceptionFallback rejects characters the code
  // page lacks (so '😀' fails BEFORE the caller backs up or writes), and it
  // re-decodes the bytes and compares, catching any silent substitution.
  const res = invoke('encode', { text: s, cp });
  const bytes = Buffer.from(String(res.text), 'base64');
  if (String(res.cp) !== String(cp)) {
    const e = new Error(`code page mismatch: requested ${cp}, converter used ${res.cp}`);
    e.code = 'LEGACY_CODEC_FAILED';
    throw e;
  }
  return bytes;
}
