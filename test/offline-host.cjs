// Test-only boundary: substitute only the two long-lived PowerShell shims.
// Registry/configuration reads and installer fixture checks still run normally.
// Never loaded by the product entry point. Opt in to real host writes with
// `node run-tests.mjs --full --live-host` on a disposable SONAR project only.
//
// Offline CAL isolation (see lib/sonar.js `calFolder`): the no-host run must
// never be able to resolve — and therefore never recursively delete — a real
// CAL folder. This preloader therefore ALWAYS points
// CAKEWALK_MCP_TEST_CAL_FOLDER at a directory it owns:
//
//   * the topmost preloaded process (no inherited CW_OFFLINE_CAL_ROOT) creates
//     an owned root `cw-offline-cal-*` under the OS temp dir, records the
//     resolved absolute path, and exports it in CW_OFFLINE_CAL_ROOT;
//   * every descendant reuses that root but makes its own absolute
//     `process-*` subdirectory, so concurrent processes cannot delete each
//     other's fixtures;
//   * an inherited root is only adopted when it is an absolute path whose
//     existing parent is the OS temp dir and whose basename matches the
//     fixture prefix — anything else is ignored and a fresh root is created;
//   * no process ever deletes a root it did not create, and each process
//     removes only its own directory on exit, after re-verifying that the
//     resolved target still lies inside the owned root.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const CAL_ENV = 'CAKEWALK_MCP_TEST_CAL_FOLDER';
const ROOT_ENV = 'CW_OFFLINE_CAL_ROOT';
const ROOT_PREFIX = 'cw-offline-cal-';

// `realpath` on the temp dir itself: on macOS os.tmpdir() is a symlink into
// /private, so both sides of every containment check must be resolved.
function realish(p) {
  try { return fs.realpathSync(p); } catch (_) { try { return path.resolve(p); } catch (_) { return null; } }
}

const TEMP_ROOT = realish(os.tmpdir());

function isWithin(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Conservative validation: reject anything that is not an absolute path that
// looks exactly like an owned fixture root sitting directly in the OS temp dir.
// The input is checked BEFORE `resolve` so a relative inherited value can never
// be reinterpreted against the cwd, and the resolved (junction/symlink-free)
// path is what must be a direct child of the real temp dir.
function adoptableRoot(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  let abs;
  try { abs = path.resolve(trimmed); } catch (_) { return null; }
  if (!TEMP_ROOT || !abs || path.dirname(abs) !== TEMP_ROOT) return null;
  if (!path.basename(abs).startsWith(ROOT_PREFIX)) return null;
  let real;
  try {
    if (!fs.statSync(abs).isDirectory()) return null;
    real = fs.realpathSync(abs);
  } catch (_) {
    return null;
  }
  // Reject junction/symlink escapes: the real path must still be a direct
  // child of the real temp dir, under the fixture prefix.
  if (!real || path.dirname(real) !== TEMP_ROOT) return null;
  if (!path.basename(real).startsWith(ROOT_PREFIX)) return null;
  return real;
}

function makeDir(parent, prefix) {
  return realish(fs.mkdtempSync(path.join(parent, prefix)));
}

// FAIL CLOSED. If no owned fixture CAL directory can be established we must not
// patch the host shims or run anything: leaving CAKEWALK_MCP_TEST_CAL_FOLDER
// unset would let lib/sonar.js fall through to the machine's real CAL folder,
// and a cleanup handler would then be free to delete real CAL scripts.
function fatal(reason) {
  delete process.env[CAL_ENV];
  delete process.env[ROOT_ENV];
  const err = new Error(
    'offline-host: refusing to run no-host tests without an isolated CAL folder ('
    + reason + '). Real CAL scripts would be at risk.');
  err.code = 'CW_OFFLINE_CAL_UNAVAILABLE';
  process.stderr.write(err.stack + '\n');
  process.exit(1);
}

let ownedRoot = null;
let ownsRoot = false;
const inheritedRaw = process.env[ROOT_ENV];
try {
  const inherited = adoptableRoot(inheritedRaw);
  if (inherited) {
    ownedRoot = inherited;
  } else {
    if (!TEMP_ROOT) fatal('no usable OS temp directory');
    ownedRoot = makeDir(TEMP_ROOT, ROOT_PREFIX); // `mkdtemp` appends the random part
    ownsRoot = true;
  }
  if (!ownedRoot || !isWithin(ownedRoot, TEMP_ROOT)) {
    fatal('fixture root is not strictly inside the OS temp directory');
  }
} catch (e) {
  fatal('fixture root creation failed: ' + (e && e.message ? e.message : e));
}

// The inherited override is never the basis of the directory we hand out, and
// it is replaced before any test body can observe it.
delete process.env[CAL_ENV];

let calDir = null;
try {
  calDir = makeDir(ownedRoot, 'process-');
} catch (e) {
  fatal('per-process fixture directory creation failed: '
    + (e && e.message ? e.message : e));
}
// Refuse to hand over any path that is not strictly inside the fixture root we
// just validated/created.
if (!calDir || !isWithin(calDir, ownedRoot) || !isWithin(realish(ownedRoot) || '', TEMP_ROOT)) {
  if (ownsRoot) {
    try { fs.rmSync(ownedRoot, { recursive: true, force: true }); } catch (_) {}
  }
  fatal('per-process fixture directory is not inside the owned fixture root');
}

process.env[ROOT_ENV] = ownedRoot;
process.env[CAL_ENV] = calDir;

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // Only ever remove our own directory, and only after re-verifying that it
  // still resolves to a location strictly inside the root we hold (and that
  // the root itself is a fixture root inside the OS temp dir).
  if (calDir && ownedRoot && isWithin(realish(ownedRoot) || '', TEMP_ROOT)
      && isWithin(realish(calDir) || '', realish(ownedRoot) || '')) {
    try { fs.rmSync(calDir, { recursive: true, force: true }); } catch (_) {}
  }
  // The root belongs to the process that created it, and only that process
  // removes it — by which point its children have already exited.
  if (ownsRoot && ownedRoot && isWithin(realish(ownedRoot) || '', TEMP_ROOT)) {
    try { fs.rmSync(ownedRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

process.once('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => { cleanup(); process.exit(130); });
}

const spawn = cp.spawn;
cp.spawn = function (file, args = [], options) {
  const script = args[args.indexOf('-Command') + 1];
  if (/(?:^|[\\/])powershell(?:\.exe)?$/i.test(file) && args.includes('-Command')
      && typeof script === 'string') {
    let mode;
    if (script.includes('function Get-Status') && script.includes("'runmenu'")) mode = 'agent';
    if (script.includes('class MidiShim') && script.includes("'sendraw'")) mode = 'midi';
    if (mode) return spawn(process.execPath, [path.join(__dirname, 'offline-shim.cjs'), mode], options);
  }
  return spawn(file, args, options);
};
syncBuiltinESMExports();
