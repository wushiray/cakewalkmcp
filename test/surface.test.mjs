// test/surface.test.mjs — the pure logic of the control-surface bridge.
//
// WHAT IS AND IS NOT COVERED HERE
//
// The interesting half of this feature cannot be tested without SONAR: whether
// SetTargetParam actually moves a fader needs a live host. Those claims are
// recorded as unverified in the README rather than asserted here.
//
// What CAN be pinned is everything that decides whether a call is even
// well-formed, and that is where the cheap mistakes live:
//   - encoding a value so 0.5 does not become the integer 0
//   - refusing a boolean where a number belongs, instead of coercing it
//   - refusing an out-of-range volume instead of truncating it silently
//   - classifying "plugin not loaded" differently from "plugin loaded but the
//     user has not added the surface yet" — different fixes, so a caller has to
//     be able to tell them apart
//
// A mock TCP server stands in for the plugin, so the framing and the waiter
// FIFO are exercised against a real socket rather than a stub.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// The mock binds port 0 and reports what the OS chose, so the suite can run
// twice at once and never collides with a real SONAR on 39177. The module's
// port is a getter over CW_SURFACE_PORT, so pointing the client at it is one
// assignment.
const surface = await import('../lib/surface.js');
const {
  SURFACE_BRIDGE,
  encodeValue, isKnownParam, SURFACE_PARAMS,
  surfaceCall, surfaceStatus, surfaceSet, surfaceParams, surfaceDiag,
  closeSurfaceClient, surfaceHelp, surfaceMidiIn,
} = surface;

let TEST_PORT = 0;   // set by startMockServer

// The client refuses to connect without a configured token (SURFACE_AUTH_REQUIRED),
// so the mock server needs a fixture token in the same environment. It is a
// throwaway 64-hex string minted for the tests and restored afterwards; the
// real token never appears here.
const FIXTURE_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  + 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PREVIOUS_TOKEN = process.env.CW_SURFACE_TOKEN;
process.env.CW_SURFACE_TOKEN = FIXTURE_TOKEN;

// ---------------------------------------------------------------- the mock --
//
// ONE server for the whole file, with a swappable handler. Rebinding the port
// per test looked tidier but is wrong: close() returns before the OS releases
// the port, so consecutive tests race and lose with EADDRINUSE. Owning a single
// listener for the file's lifetime removes the race instead of retrying it.

let server = null;
const sockets = new Set();
let replyFor = () => '{"ok":false,"error":"no handler"}';

/** How the mock answers. Pass a function of (msg) -> reply string, or null to
 *  say nothing (which is how the timeout path gets exercised). */
function setHandler(fn) {
  replyFor = fn;
}

function startMockServer() {
  return new Promise((resolve) => {
    server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg = null;
          try { msg = JSON.parse(line); } catch { /* reported as bad json */ }
          const reply = replyFor(msg);
          if (reply !== null && reply !== undefined) sock.write(reply + '\n');
        }
      });
      sock.on('error', () => { /* torn down by the test */ });
    });
    // Port 0 assigns a free port; read back which one the OS picked.
    server.listen(0, '127.0.0.1', () => {
      TEST_PORT = server.address().port;
      process.env.CW_SURFACE_PORT = String(TEST_PORT);
      resolve();
    });
  });
}

async function stopMockServer() {
  for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
  sockets.clear();
  if (server) {
    await new Promise((r) => server.close(r));
    server = null;
  }
}

/** The default happy-path handler most tests want. */
const HAPPY = (msg) => {
  if (!msg) return '{"ok":false,"error":"bad json"}';
  switch (msg.op) {
    case 'ping': return '{"ok":true,"pong":true}';
    case 'status': return `{"ok":true,"connected":true,"port":${TEST_PORT},"refs":2,"refresh":10,"sets":1,"failures":0}`;
    case 'diag': return '{"ok":true,"connected":true,"qi":{"dispatch":1,"unknown":1,"surface":1,"surface2":1,"surface3":1},"log":["Connect: pobj=0x1"]}';
    case 'params': return '{"ok":true,"params":[{"name":"MUTE","value":2}]}';
    case 'set': return JSON.stringify({ ok: true, param: msg.param, track: msg.track, value: msg.value });
    default: return '{"ok":false,"error":"unknown op"}';
  }
};

before(async () => {
  await startMockServer();
  // The default handler has to be the happy path, or the first tests to run
  // reach the mock before any of them has had a chance to configure it.
  setHandler(HAPPY);
});

after(async () => {
  closeSurfaceClient();
  await stopMockServer();
  // Put the caller's token back: the fixture above overwrote CW_SURFACE_TOKEN
  // for the whole process, and leaving it in place would hand every later test
  // in this process a fake token instead of the one it was configured with.
  if (PREVIOUS_TOKEN === undefined) delete process.env.CW_SURFACE_TOKEN;
  else process.env.CW_SURFACE_TOKEN = PREVIOUS_TOKEN;
});

// ------------------------------------------------------------- pure encoding --

describe('encodeValue', () => {
  test('booleans become 1 and 0, not "true"/"false"', () => {
    assert.equal(encodeValue('MUTE', true), 1);
    assert.equal(encodeValue('MUTE', false), 0);
    assert.equal(encodeValue('RECORD_ARM', true), 1);
  });

  test('accepts 0/1 for a boolean without accepting 2', () => {
    assert.equal(encodeValue('SOLO', 1), 1);
    assert.equal(encodeValue('SOLO', 0), 0);
    assert.throws(() => encodeValue('SOLO', 2), /boolean/);
  });

  test('refuses a truthy string rather than coercing it', () => {
    // The dangerous version of this bug: 'false' is truthy, so a loose
    // implementation would arm recording on a request to disarm it.
    assert.throws(() => encodeValue('RECORD_ARM', 'false'), /boolean/);
    assert.throws(() => encodeValue('MUTE', 'yes'), /boolean/);
  });

  test('pan maps -1..1 onto 0..1000 with 0 dead centre', () => {
    assert.equal(encodeValue('PAN', -1), 0);
    assert.equal(encodeValue('PAN', 0), 500);
    assert.equal(encodeValue('PAN', 1), 1000);
  });

  test('volume 0.5 survives as 500, not as 0', () => {
    // Math.trunc would make 0.5 into 500 too, so that value alone does NOT
    // distinguish truncation from rounding. 0.3335 is the one that does:
    // round gives 334, trunc gives 333. Without this case the test passes
    // against a truncating implementation, which is how this was caught.
    assert.equal(encodeValue('VOL', 0.3335), 334, 'must round, not truncate');
    assert.equal(encodeValue('VOL', 0.5), 500);
    assert.equal(encodeValue('VOL', 0), 0);
    assert.equal(encodeValue('VOL', 1), 1000);
    // And the boundary that would silently mute a track.
    assert.equal(encodeValue('VOL', 0.0005), 1, 'a tiny non-zero volume must not become 0');
  });

  test('pan resolves half-steps upward and keeps the sign of real offsets', () => {
    // At this scale +0.001 and -0.001 both give exactly 499.5, and Math.round
    // sends .5 upward, so both land on 500. That is a genuine property of the
    // 0..1000 quantisation, not an accident: it means offsets smaller than
    // 0.002 are not representable. Pinned literally so a change to the scaling
    // (or to the rounding rule) shows up here.
    assert.equal(encodeValue('PAN', 0.001), 500);
    assert.equal(encodeValue('PAN', -0.001), 500, 'half-steps round toward +infinity');
    // Offsets that ARE representable must keep their side.
    assert.equal(encodeValue('PAN', 0.002), 501);
    assert.equal(encodeValue('PAN', -0.002), 499);
    assert.equal(encodeValue('PAN', 0.5), 750);
    assert.equal(encodeValue('PAN', -0.5), 250);
    assert.equal(encodeValue('PAN', 0), 500);
  });

  test('refuses a value outside the mixer range instead of truncating', () => {
    // 300 looks like a MIDI CC7 value. Passing it through as "300" would clamp
    // somewhere unpredictable, so it is refused with the range in the message.
    assert.throws(() => encodeValue('VOL', 300), /0\.\.1/);
    assert.throws(() => encodeValue('PAN', 2), /-1\.\.1/);
    assert.throws(() => encodeValue('PAN', -2), /-1\.\.1/);
  });

  test('refuses a non-integer for an integer parameter', () => {
    assert.throws(() => encodeValue('PATCH', 1.5), /integer/);
    assert.throws(() => encodeValue('INPUT', NaN), /number/);
    assert.throws(() => encodeValue('OUTPUT', Infinity), /number/);
  });

  test('parameter names are case-insensitive', () => {
    assert.equal(encodeValue('mute', true), encodeValue('MUTE', true));
    assert.equal(encodeValue('Patch', 7), 7);
  });

  test('an unknown parameter is refused, not passed through', () => {
    assert.throws(() => encodeValue('NOT_A_PARAM', 1), /unknown surface parameter/);
  });
});

describe('the parameter vocabulary', () => {
  test('isKnownParam agrees with the table', () => {
    for (const k of Object.keys(SURFACE_PARAMS)) assert.equal(isKnownParam(k), true);
    assert.equal(isKnownParam('NOPE'), false);
  });

  test('the enum values match what cw_surface.c declares', () => {
    // These numbers are the interface: a drift between this table and the C
    // enum would set the wrong property with no error anywhere. Spelled out
    // literally so a careless edit to either side fails here.
    const expected = {
      VOL: 0, PAN: 1, MUTE: 2, SOLO: 3, ARCHIVE: 4, RECORD_ARM: 5,
      INPUT: 10, OUTPUT: 12, BANK: 14, PATCH: 15,
      SEND_ENABLE: 19, SEND_VOL: 21, SEND_PAN: 22,
      FX: 26, FX_PARAM: 29,
    };
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(SURFACE_PARAMS[k].value, v, `${k} should be ${v}`);
    }
  });

  test('every entry declares a kind', () => {
    for (const [k, def] of Object.entries(SURFACE_PARAMS)) {
      assert.ok(['bool', 'scalar', 'int'].includes(def.kind), `${k} has kind ${def.kind}`);
    }
  });
});

// ---------------------------------------------------------- socket behaviour --

describe('the socket protocol', () => {
  test('a request round-trips', async () => {
    const r = await surfaceCall({ op: 'ping' });
    assert.equal(r.ok, true);
    assert.equal(r.pong, true);
  });

  test('many requests in flight keep their order', async () => {
    // The waiter list is a FIFO, so a reply that arrives out of order would be
    // handed to the wrong caller. The mock answers in order; this pins that the
    // client does too.
    const results = await Promise.all([
      surfaceCall({ op: 'ping' }),
      surfaceCall({ op: 'params' }),
      surfaceCall({ op: 'status' }),
    ]);
    assert.equal(results[0].pong, true);
    assert.ok(Array.isArray(results[1].params));
    assert.equal(results[2].connected, true);
  });

  test('two replies in one packet are both delivered', async () => {
    // TCP has no message boundaries, so a single read can carry several lines.
    // A client that parsed only the first would hang on the second call. The
    // handler answers BOTH queued pings with one write, which is what a real
    // burst looks like on the wire.
    let burst = 0;
    setHandler((msg) => {
      if (!msg || msg.op !== 'ping') return '{"ok":false}';
      burst += 1;
      // The first request gets both replies in a single write; the second then
      // finds its answer already buffered on the client.
      return burst === 1
        ? '{"ok":true,"pong":true,"n":1}\n{"ok":true,"pong":true,"n":2}'
        : null;
    });
    closeSurfaceClient();

    const [a, b] = await Promise.all([
      surfaceCall({ op: 'ping' }),
      surfaceCall({ op: 'ping' }),
    ]);
    assert.equal(a.n, 1);
    assert.equal(b.n, 2, 'the second line of a coalesced packet must reach its own waiter');
  });

  test('a timeout is reported as SURFACE_TIMEOUT, not a hang', async () => {
    setHandler(() => null);   // never answers
    closeSurfaceClient();

    await assert.rejects(
      () => surfaceCall({ op: 'ping' }, { timeoutMs: 120 }),
      (e) => e.code === 'SURFACE_TIMEOUT'
    );
    setHandler(HAPPY);
  });

  test('an unreachable plugin is SURFACE_UNREACHABLE with the address named', async () => {
    // Close the listener for this one: the point is what the client says when
    // nothing is there.
    await stopMockServer();
    closeSurfaceClient();
    try {
      await assert.rejects(
        () => surfaceCall({ op: 'ping' }, { timeoutMs: 400 }),
        (e) => e.code === 'SURFACE_UNREACHABLE'
          && e.message.includes('127.0.0.1')
          && e.message.includes(String(TEST_PORT))
      );
    } finally {
      await startMockServer();
      setHandler(HAPPY);
    }
  });
});

// ------------------------------------------------------------- status shapes --

describe('surfaceStatus', () => {
  test('reports "ready" when the plugin is connected', async () => {
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'status') return '{"ok":true,"connected":true,"refresh":5,"sets":2,"failures":0}';
      return '{"ok":false}';
    });
    closeSurfaceClient();
    const st = await surfaceStatus();
    assert.equal(st.state, 'ready');
    assert.equal(st.connected, true);
    assert.equal(st.bridge_reachable, true);
  });

  test('reports "needs-user-setup" — with the menu path — before Connect', async () => {
    // This is the state a fresh install is in, and it must not look like a bug:
    // the fix is a specific action the user has to take in the UI.
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'status') return '{"ok":true,"connected":false,"refresh":0,"sets":0,"failures":0}';
      return '{"ok":false}';
    });
    closeSurfaceClient();
    const st = await surfaceStatus();
    assert.equal(st.state, 'needs-user-setup');
    assert.equal(st.connected, false);
    assert.ok(st.actions.some((a) => a.includes('控制面板')),
      'the setup instructions must name the actual menu');
  });

  test('reports "not-installed" when nothing is listening', async () => {
    await stopMockServer();
    closeSurfaceClient();
    try {
      const st = await surfaceStatus();
      assert.equal(st.state, 'not-installed');
      assert.equal(st.bridge_reachable, false);
      assert.ok(st.actions.length > 0, 'must say how to install it');
    } finally {
      await startMockServer();
      setHandler(HAPPY);
    }
  });
});

describe('surfaceSet', () => {
  test('sends the encoded integer, not the caller\'s float', async () => {
    let seen = null;
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'set') { seen = msg; return JSON.stringify({ ok: true, track: msg.track, param: msg.param, value: msg.value }); }
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();   // drop any socket pointing at the previous mock

    await surfaceSet(3, 'VOL', 0.25);
    assert.ok(seen, 'the mock should have seen the set');
    assert.equal(seen.track, 3);
    assert.equal(seen.param, 'VOL');
    assert.equal(seen.value, 250, '0.25 must arrive as 250, not 0.25 or 0');
  });

  test('a refusal from the plugin becomes SURFACE_REFUSED with its reason', async () => {
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'set') return '{"ok":false,"error":"not connected: SONAR has not called Connect"}';
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();

    await assert.rejects(
      () => surfaceSet(1, 'MUTE', true),
      (e) => {
        assert.equal(e.code, 'SURFACE_REFUSED');
        assert.match(e.message, /not connected/);
        // The caller can distinguish "set it up in the UI" from "that value is
        // wrong" without parsing English.
        assert.equal(e.needsUserSetup, true);
        return true;
      }
    );
  });

  test('an error containing a double quote is refused, not reported as unparseable', async () => {
    // This is a regression test for a real bug. The DLL built its error string
    // with the inner quotes unescaped, producing
    //   {"ok":false,"error":"...see op:"probe" for..."}
    // which is invalid JSON. The client then failed at JSON.parse and reported
    // "surface bridge sent unparseable JSON", burying the message that actually
    // explained the problem. The DLL now escapes; this pins that the client
    // surfaces the real reason when the plugin gets it right, and — just as
    // importantly — that a malformed reply is an error the caller can see
    // rather than a silent hang.
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'set') {
        // Note the escaped quotes: this is what a correct plugin emits.
        return '{"ok":false,"error":"host object does not implement IDispatch, see op:\\"probe\\""}';
      }
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();

    await assert.rejects(
      () => surfaceSet(1, 'MUTE', true),
      (e) => {
        assert.equal(e.code, 'SURFACE_REFUSED');
        assert.match(e.message, /does not implement IDispatch/);
        assert.match(e.message, /"probe"/, 'the inner quotes must survive the round trip');
        return true;
      }
    );
  });

  test('a genuinely malformed reply is reported, not swallowed', async () => {
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'set') return '{"ok":false,"error":"unescaped "quote" breaks this"}';
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();

    await assert.rejects(
      () => surfaceSet(1, 'MUTE', true),
      (e) => {
        assert.match(e.message, /unparseable JSON/);
        // And the offending text must be included, or there is nothing to debug
        // from on the caller side.
        assert.match(e.message, /unescaped/);
        return true;
      }
    );
  });

  test('a bad track index is refused before any socket work', async () => {
    await assert.rejects(() => surfaceSet(-1, 'MUTE', true), /non-negative integer/);
    await assert.rejects(() => surfaceSet(1.5, 'MUTE', true), /non-negative integer/);
  });

  test('an out-of-range value never reaches the plugin', async () => {
    let touched = false;
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'set') { touched = true; return '{"ok":true}'; }
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();
    await assert.rejects(() => surfaceSet(1, 'VOL', 99), /0\.\.1/);
    assert.equal(touched, false, 'the plugin must not be asked to clamp');
  });
});

describe('MIDI in, the one working half of the bridge', () => {
  test('decodes each status nibble into the right message type', async () => {
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'midi') {
        return JSON.stringify({ ok: true, total: 8, kept: 8, events: [
          { raw: 1, status: '0xB0', d1: 7, d2: 64, tick: 100 },
          { raw: 2, status: '0x90', d1: 60, d2: 100, tick: 101 },
          { raw: 3, status: '0x80', d1: 60, d2: 0, tick: 102 },
          { raw: 4, status: '0xC0', d1: 5, d2: 0, tick: 103 },
          { raw: 5, status: '0xE0', d1: 0, d2: 64, tick: 104 },
          { raw: 6, status: '0xA0', d1: 50, d2: 20, tick: 105 },
          { raw: 7, status: '0xD0', d1: 30, d2: 0, tick: 106 },
          { raw: 8, status: '0xF8', d1: 0, d2: 0, tick: 107 },
        ] });
      }
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();

    const r = await surfaceMidiIn();
    assert.equal(r.total, 8);
    assert.deepEqual(r.decoded.map((e) => e.type), [
      'controlChange', 'noteOn', 'noteOff', 'programChange',
      'pitchBend', 'aftertouch', 'channelPressure', 'other',
    ]);
  });

  test('the channel is reported 1-based, as a musician counts it', async () => {
    // MIDI wire channel 0 is "channel 1" to everyone who uses the DAW, so
    // reporting the raw nibble would be off by one for every caller.
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'midi') return JSON.stringify({ ok: true, total: 3, kept: 3, events: [
        { raw: 1, status: '0xB0', d1: 7, d2: 1, tick: 1 },
        { raw: 2, status: '0xB1', d1: 7, d2: 2, tick: 2 },
        { raw: 3, status: '0xBF', d1: 7, d2: 3, tick: 3 },
      ] });
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();

    const r = await surfaceMidiIn();
    assert.deepEqual(r.decoded.map((e) => e.channel), [1, 2, 16]);
  });

  test('a control change exposes which controller it is', async () => {
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'midi') return JSON.stringify({ ok: true, total: 2, kept: 2, events: [
        { raw: 1, status: '0xB0', d1: 7, d2: 100, tick: 1 },
        { raw: 2, status: '0x90', d1: 60, d2: 100, tick: 2 },
      ] });
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();

    const r = await surfaceMidiIn();
    // A CC names its controller (7 = volume); a note-on has no controller, and
    // leaving that field undefined is clearer than inventing a 0.
    assert.equal(r.decoded[0].control, 7);
    assert.equal(r.decoded[0].value, 100);
    assert.equal(r.decoded[1].control, undefined);
  });

  test('an empty capture is zero, not an error', async () => {
    // The normal state before the surface has been given the right input port:
    // measured as total = 0 until the port was assigned in Preferences.
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'midi') return '{"ok":true,"total":0,"kept":0,"events":[]}';
      return '{"ok":true,"connected":true}';
    });
    closeSurfaceClient();

    const r = await surfaceMidiIn();
    assert.equal(r.total, 0);
    assert.deepEqual(r.decoded, []);
  });
});

describe('diagnostics and help', () => {
  test('surfaceDiag returns the plugin\'s own log', async () => {
    setHandler((msg) => {
      if (msg.op === 'ping') return '{"ok":true,"pong":true}';
      if (msg.op === 'diag') return '{"ok":true,"qi":{"dispatch":1},"log":["Connect: pobj=0x1"]}';
      return '{"ok":true}';
    });
    closeSurfaceClient();
    const d = await surfaceDiag();
    assert.equal(d.qi.dispatch, 1);
    assert.deepEqual(d.log, ['Connect: pobj=0x1']);
  });

  test('surfaceHelp names the mechanism and carries the install steps', () => {
    const h = surfaceHelp();
    assert.ok(h.howToInstall.length >= 2);
    assert.ok(h.architecture.transport.includes('TCP'));
    // The help is where a reader learns this is a supported extension point and
    // not a licensing workaround, so that claim must be present.
    assert.match(h.why, /extension point/);
  });
});
