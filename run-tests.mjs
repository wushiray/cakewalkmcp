// run-tests.mjs — run the test suite and print one verdict.
//
// node --test spawns a process per file, which is right for isolation but hides
// the total. This wrapper exists so a single command gives one clear number.
//
// It counts from the runner's completion events rather than by parsing reporter
// text, and writes the summary to a file as well as stdout — process.exit() can
// beat the stdout flush when output is redirected, and the file is the record.
//
// TWO TIERS, because the full run takes about seven minutes and almost all of
// that is spent waiting on real processes. Editing one line and waiting seven
// minutes to learn whether it broke something is how a suite stops being run.
//
//   fast (default)  the suites that import a module and call it. No SONAR, no
//                   bridge, no spawned server, no filesystem writes outside
//                   tmp. Roughly a second, so it can run on every change.
//   full (--full)   adds the suites that spawn the MCP server or drive the
//                   PowerShell bridge. These are the ones that catch wiring and
//                   composition defects, and they are the ones that are slow.
//
// The tier is decided by an explicit list, not by timing or heuristics: a test
// that quietly changes tier is a test that quietly stops running.

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { readdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'test');
const full = process.argv.includes('--full');
const liveHost = process.argv.includes('--live-host');
if (!liveHost) {
  const preload = join(here, 'test', 'offline-host.cjs').replace(/\\/g, '/');
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`.trim();
}
process.stdout.write(`Host mode: ${liveHost ? 'LIVE (disposable project required)' : 'offline shim fixture; no DAW/MIDI writes'}\n`);

// Suites that spawn a process, open the bridge, or otherwise leave this one.
// Everything not named here is fast by construction.
const SLOW_SUITES = new Set([
  'integration.test.mjs',   // spawns the MCP server, speaks JSON-RPC
  'blackbox.test.mjs',      // same, and probes the live SONAR menu
  'capability.test.mjs',    // drives the PowerShell bridge
  'deploy-budget-regressions.test.mjs', // spawns Windows PowerShell 5.1 per case
  'deploy-ownership-regressions.test.mjs', // real PowerShell AST fixture, no DAW writes
  // The four below were observed leaving this process: each spawns a child and
  // waits on it, so they belong in the full tier even though their names do not
  // say "integration".
  'save-safety-regressions.test.mjs',
  'midi-text-encoding.test.mjs',
  'template-dialog.test.mjs',
  'offline-cal-isolation.test.mjs',
  'rename-readback.test.mjs',
]);

const all = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

/*
 * A tier is only trustworthy if a missing file is an error rather than a silent
 * promotion. Naming a suite in SLOW_SUITES and then renaming the file would have
 * moved the slowest suite into the fast tier with nothing to show for it — an
 * adversarial audit flagged exactly this, and demonstrated it by renaming
 * blackbox.test.mjs and watching the fast tier pick it up. So every entry is
 * checked to exist, and an unlisted suite is reported so a NEW slow suite is
 * noticed rather than assumed fast.
 */
const missing = [...SLOW_SUITES].filter((f) => !all.includes(f));
if (missing.length) {
  const msg = `run-tests: SLOW_SUITES names ${missing.join(', ')} but no such file exists. `
    + 'Rename the entry, or the suite it used to guard is now in the fast tier silently.';
  process.stderr.write(msg + '\n');
  process.exit(2);
}

const files = (full ? all : all.filter((f) => !SLOW_SUITES.has(f))).map((f) => join(dir, f));
const skipped = full ? [] : all.filter((f) => SLOW_SUITES.has(f));

const counts = { pass: 0, fail: 0, skip: 0, todo: 0 };
const failures = [];
const started = Date.now();
/*
 * Per-suite counts, collected from the events rather than hand-maintained.
 *
 * README used to carry these numbers by hand, and an adversarial audit caught it
 * three separate times: the headline total, the per-suite rows and the directory
 * tree disagreed with each other and with reality, because they were written at
 * different moments while the suite was still growing. Counting them here and
 * printing the block means the only number anyone has to keep in step is a copy,
 * and a copy that drifts is visible in one diff.
 */
const bySuite = new Map();

const stream = run({ files, concurrency: 1 });

stream.on('test:pass', (t) => {
  // Skip and TODO arrive HERE, on test:pass, carrying their flags — the
  // dedicated test:skip listener below never fires on this Node (22.x). The
  // original `if (t.skip || t.todo) return;` silently swallowed them: a run of
  // one pass + one skip + one TODO reported 1 passed, 0 failed, 0 skipped, so
  // unexecuted tests were invisible in the headline (audit finding F6).
  if (t.skip) { counts.skip++; skipped.push(t.name); return; }
  if (t.todo) { counts.todo++; return; }
  counts.pass++;
  const f = basename(t.file || 'unknown');
  const entry = bySuite.get(f) || { pass: 0, fail: 0 };
  entry.pass++;
  bySuite.set(f, entry);
});
stream.on('test:fail', (t) => {
  counts.fail++;
  failures.push(t.name);
  const f = basename(t.file || 'unknown');
  const entry = bySuite.get(f) || { pass: 0, fail: 0 };
  entry.fail++;
  bySuite.set(f, entry);
});
stream.on('test:skip', () => counts.skip++);

stream.compose(new spec()).pipe(process.stdout);

stream.on('end', () => {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const lines = [
    '',
    '='.repeat(64),
    `  ${full ? 'full' : 'fast'} suite: ${files.length} files, ${secs}s`,
    `  ${counts.pass} passed, ${counts.fail} failed`
      + (counts.skip ? `, ${counts.skip} skipped` : '')
      + (counts.todo ? `, ${counts.todo} todo` : ''),
  ];
  if (skipped.length) {
    // Say what was left out, and how to run it. A fast tier that silently
    // under-reports is worse than no fast tier.
    lines.push('', `  not run in this tier (${skipped.length}):`);
    for (const f of skipped) lines.push('    - ' + basename(f));
    lines.push('', '  run them with:  node run-tests.mjs --full');
  }

  /*
   * The tier an unlisted suite lands in is a guess this script makes from a name.
   * Say which suites that guess applies to, so a NEW slow suite is noticed by
   * whoever added it instead of quietly inflating the fast tier.
   */
  const unclassified = all.filter((f) => !SLOW_SUITES.has(f));
  if (!full && unclassified.length) {
    lines.push('', `  assumed fast, by name only (${unclassified.length}): `
      + unclassified.join(', '));
  }

  if (failures.length) {
    lines.push('', '  failures:');
    for (const f of failures) lines.push('    - ' + f);
  }

  /*
   * The per-suite block below is the source README's table should be copied from.
   * These are runner counts — every passing assertion, nested describe blocks
   * included — which is NOT the same as `node --test`'s top-level `# tests` figure.
   * Mixing the two conventions is what produced three disagreeing totals before;
   * one convention, printed here, is the fix.
   */
  const suiteLines = [...bySuite.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, c]) => `    ${f.padEnd(26)} ${String(c.pass).padStart(4)}`
      + (c.fail ? `  (${c.fail} failed)` : ''));

  lines.push('', `  per-suite (runner counts):`, ...suiteLines);
  lines.push('='.repeat(64), '');
  const text = lines.join('\n');

  try { writeFileSync(join(here, 'test-results.txt'), text, 'utf8'); } catch (_) { /* best effort */ }
  process.stdout.write(text, () => process.exit(counts.fail ? 1 : 0));
});
