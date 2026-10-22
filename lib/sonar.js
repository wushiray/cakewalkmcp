// lib/sonar.js — locate and inspect the local SONAR install.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Cakewalk/SONAR/Sonar.exe',
  'C:/Program Files (x86)/Cakewalk/SONAR/Sonar.exe',
  'D:/CAKEWALK/Sonar.exe',
];

let cached = null;

export function findSonar() {
  if (cached) return cached;
  for (const p of CANDIDATES) {
    if (existsSync(p)) {
      cached = p;
      return p;
    }
  }
  // Fallback: check registry HKLM\SOFTWARE\Cakewalk Music Software\Cakewalk\Sonar
  try {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Sonar" /v InstallPath 2>nul',
      { encoding: 'utf8' }
    );
    const m = out.match(/InstallPath\s+REG_SZ\s+([^\r\n]+)/);
    if (m) {
      const p = join(m[1].trim(), 'Sonar.exe');
      if (existsSync(p)) { cached = p; return p; }
    }
  } catch (_) {}
  return null;
}

// Version is a property of the installed file, not of the session, and reading it
// costs a PowerShell start (~1.3 s, synchronously blocking the event loop). Cache
// per path; the file's mtime key makes an update invalidate it.
const versionCache = new Map();

export function sonarVersion(exePath) {
  const p = exePath || findSonar();
  if (!p) return null;
  let key = p;
  try { key = p + '|' + statSync(p).mtimeMs; } catch (_) { /* path may be gone */ }
  if (versionCache.has(key)) return versionCache.get(key);
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Item '${p}').VersionInfo | Select-Object ProductName,ProductVersion,FileVersion | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const parsed = JSON.parse(out);
    versionCache.set(key, parsed);
    return parsed;
  } catch (_) { return null; }
}

export function isSonarRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Sonar.exe" /NH', { encoding: 'utf8' });
    return /Sonar\.exe/i.test(out);
  } catch (_) { return false; }
}

export function scriptsFolder() {
  // Read registry: HKCU\SOFTWARE\Cakewalk Music Software\Cakewalk\Sonar\UserPaths\CakeScriptFilesFolder
  try {
    const out = execSync(
      'reg query "HKCU\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Sonar\\UserPaths" /v CakeScriptFilesFolder 2>nul',
      { encoding: 'utf8' }
    );
    const m = out.match(/CakeScriptFilesFolder\s+REG_SZ\s+([^\r\n]+)/);
    if (m) return m[1].trim();
  } catch (_) {}
  return 'D:/CAKEWALK/Cakewalk Content/Sonar/CakeScript Scripts';
}

/**
 * The folder SONAR loads CAL programs from — a DIFFERENT folder from the
 * CakeScript one above, and the value name is `CalFolder`, not
 * `CALFileDir` or `CALFilesFolder` (neither of those exists; an earlier search
 * for them found nothing, and the distinction matters because writing a CAL
 * script into the CakeScript folder produces a file the CAL dialog will not
 * list).
 *
 * Two scopes are read, because Cakewalk ships both a Sonar and a Core tree and
 * either can be the installed product. Sonar wins when both exist.
 *
 * Measured on this machine: `...\Cakewalk\Sonar\UserPaths\CalFolder` =
 * "D:\CAKEWALK\Cakewalk Content\Sonar\CAL Scripts" (a real directory, not a
 * junction), while `...\Cakewalk\Core\UserPaths\CalFolder` points at the
 * Cakewalk Core tree. No config file names a CAL path, so the registry is the
 * only dynamic source; the literal fallback is this machine's layout and exists
 * solely so the module still answers when the registry is unreadable.
 */
export function calFolder() {
  for (const scope of ['Sonar', 'Core']) {
    try {
      const out = execSync(
        `reg query "HKCU\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\${scope}\\UserPaths" /v CalFolder 2>nul`,
        { encoding: 'utf8' }
      );
      const m = out.match(/CalFolder\s+REG_SZ\s+([^\r\n]+)/);
      if (m && m[1].trim()) return m[1].trim();
    } catch (_) { /* try the next scope */ }
  }
  return 'D:/CAKEWALK/Cakewalk Content/Sonar/CAL Scripts';
}
