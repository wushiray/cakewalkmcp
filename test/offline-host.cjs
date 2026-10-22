// Test-only boundary: substitute only the two long-lived PowerShell shims.
// Registry/configuration reads and installer fixture checks still run normally.
// Never loaded by the product entry point. Opt in to real host writes with
// `node run-tests.mjs --full --live-host` on a disposable SONAR project only.
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
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
