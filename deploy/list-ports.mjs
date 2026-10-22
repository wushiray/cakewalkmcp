// deploy/list-ports.mjs — print the MIDI output port names as JSON.
//
// Exists as a file rather than a `node -e` one-liner because the installer calls
// it from PowerShell: an inline expression would need three levels of quoting on
// a line that already contains braces and brackets. A file has no quoting layer
// to get wrong, which is the same reason make-baseline.mjs exists.
//
// Why the installer needs it: a virtual MIDI cable's ports only exist while the
// cable's app is running, so "loopMIDI is installed" and "the adapter can send"
// are different facts. Port presence is the only reliable evidence of the second.
import { devices } from '../lib/live.js';

try {
  const all = await devices();
  const out = all.filter((d) => d.dir === 'out').map((d) => d.name);
  console.log(JSON.stringify(out));
} catch (e) {
  // A broken MIDI subsystem must not fail the install: this is a report step.
  console.error(e.message);
  console.log('[]');
}
process.exit(0);
