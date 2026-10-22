// A no-host fixture that speaks the same line protocol, including request IDs.
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  if (req.op === 'quit') return process.exit(0);
  let out;
  if (process.argv[2] === 'midi') {
    out = req.op === 'devices' ? { devices: [] }
      : { ok: false, code: 'NO_PORT_OPEN', error: 'no port open (offline test fixture)' };
  } else {
    switch (req.op) {
      case 'status': out = { sonar: { found: false }, assistant: { found: false }, allWindows: [] }; break;
      case 'menu': out = { menu: [], error: 'sonar not running' }; break;
      case 'overlays': out = { overlays: [] }; break;
      default: out = { ok: false, error: 'sonar not running' };
    }
  }
  console.log(JSON.stringify({ ...out, id: req.id }));
});
