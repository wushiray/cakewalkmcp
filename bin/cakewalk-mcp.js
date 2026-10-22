#!/usr/bin/env node
// bin/cakewalk-mcp.js — entry point.

// node:sqlite is how we read SONAR's command index; it is still flagged
// experimental and emits a warning on first use, which would land in the MCP
// log. Static imports run before any top-level statement, so the modules are
// loaded dynamically to get this filter installed first.
const origEmit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  return origEmit.call(process, warning, ...rest);
};

const [{ runServer }, { startBridge, stopBridge }, { startMidi, stopMidi }] = await Promise.all([
  import('../lib/server.js'),
  import('../bridge/agent.js'),
  import('../bridge/midi.js'),
]);

// Both shims are long-lived: the user32 bridge amortises PowerShell startup,
// and the MIDI shim keeps the winmm port handle open so sends stay flat.
startBridge();
startMidi();

function shutdown() {
  try { stopMidi(); } catch (_) {}
  try { stopBridge(); } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => process.stderr.write(`[cakewalk-mcp] uncaught: ${e.stack}\n`));

runServer().catch((e) => {
  process.stderr.write(`[cakewalk-mcp] fatal: ${e.stack}\n`);
  process.exit(1);
});
