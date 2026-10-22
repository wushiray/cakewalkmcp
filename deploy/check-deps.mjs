// deploy/check-deps.mjs — are this package's dependencies present AND loadable?
//
// Two things went wrong before, both measured by the adversarial audit:
//
//   1. `createRequire(...).resolve('@modelcontextprotocol/sdk/server/mcp.js')`
//      resolves the CJS build (the package's "require" condition), while
//      lib/server.js imports the ESM build ("import"). Deleting dist/esm made
//      the probe print OK while the server died with ERR_MODULE_NOT_FOUND.
//      The probe must import the same specifiers the server imports.
//
//   2. Node's resolution walks UP the directory tree, so a package extracted
//      inside another project finds the PARENT's node_modules. The old probe
//      used that to report ready when its own copy was missing. Every resolved
//      URL is therefore required to sit inside the package root.
//
// Exit codes: 0 = both dependencies load from inside the package, 1 = otherwise,
// 2 = bad usage.
import { pathToFileURL } from 'node:url';
import { sep } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.log('NO_ROOT');
  process.exit(2);
}

const clean = root.replace(/[\\/]+$/, '');
const rootUrl = pathToFileURL(clean + sep).href.toLowerCase();
// Require the modules to come from THIS package's node_modules. Resolving from
// deploy/ meant a deploy\node_modules could satisfy the probe while the root
// copy the server actually loads was broken.
const modulesUrl = pathToFileURL(clean + sep + 'node_modules' + sep).href.toLowerCase();

// The exact specifiers lib/server.js imports. zod is a direct dependency and
// was never checked at all.
// The specifiers lib/server.js actually imports. Keep this list in step with
// that file: the round-2 audit found server/stdio.js missing here, and deleting
// just that file still produced OK while the server failed to start.
const SPECS = [
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  'zod',
];

for (const spec of SPECS) {
  let url;
  try {
    url = import.meta.resolve(spec);
  } catch (e) {
    console.log(`MISSING ${spec} (${e.code || e.message})`);
    process.exit(1);
  }
  if (!url.toLowerCase().startsWith(modulesUrl)) {
    console.log(`OUTSIDE ${spec} -> ${url}`);
    process.exit(1);
  }
  try {
    // Resolving is not loading: a truncated install can resolve a file that
    // throws on evaluation. Import the real module graph.
    await import(spec);
  } catch (e) {
    console.log(`UNLOADABLE ${spec} (${e.code || e.message})`);
    process.exit(1);
  }
}

console.log('OK ' + SPECS.join(' + '));
process.exit(0);
