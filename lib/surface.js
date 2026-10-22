// lib/surface.js — talk to the cw_surface control-surface plugin inside SONAR.
//
// THE TWO HALVES
//
// The plugin (native/surface/cw_surface.c) runs *inside* SONAR and owns a
// loopback TCP listener. This module is the other half: a client that speaks
// line-delimited JSON to it. Same shape as the project's other bridges
// (bridge/agent.js, bridge/midi.js) so callers see one idiom, not three.
//
// WHY A SOCKET AND NOT SOMETHING ELSE
//
// The plugin is in SONAR's process and this is a separate Node process, so
// there has to be an IPC channel. Loopback TCP is chosen over a named pipe
// because pipes carry an access token and are therefore gated by integrity
// level: if SONAR runs elevated and Node does not (or the reverse), a pipe
// fails with a permission error that looks like a bug. Loopback has no such
// gate, so an elevation mismatch produces a working bridge instead of a
// mystery. SONAR itself already ships a loopback listener, so this is a pattern
// the host already uses.
//
// WHY "NOT CONNECTED" IS A NORMAL ANSWER, NOT AN ERROR
//
// The socket being up only means the DLL is loaded. The plugin cannot touch the
// project until SONAR calls IControlSurface::Connect and hands it the host
// object. Until the user has added the surface in Preferences > MIDI >
// Control Surfaces, every write returns {"ok":false,"error":"not connected..."}.
// That is a setup state, not a failure, so surfaceStatus() reports it as
// `needs_user_setup` with the exact menu path rather than throwing.

import net from 'node:net';
import { connect as netConnect } from 'node:net';

export const SURFACE_BRIDGE = {
  host: '127.0.0.1',
  // Default must match CW_DEFAULT_PORT in cw_surface.c. A second instance can be
  // moved with the CW_SURFACE_PORT env var, which the DLL reads at load time.
  //
  // Read through a getter rather than frozen at import time, so a caller (or a
  // test) can point the client somewhere else after the module is loaded. A
  // value captured at import makes the port untestable without process-level
  // tricks, and a fixed port makes two test runs collide.
  get port() {
    return Number(process.env.CW_SURFACE_PORT || this.defaultPort);
  },
  defaultPort: 39177,
  // The plugin answers in microseconds once loaded; this is only generous
  // enough to cover a cold process and a busy UI thread.
  //
  // Raised from 4000 because `call` runs the callee under a watchdog in the
  // plugin (kCallTimeoutMs, 2500ms) and then has to format and send a reply. A
  // client timeout equal to the plugin's own produced a "did not answer"
  // message on requests that were about to succeed — the reply arrived, the
  // client had already given up, and the failure looked like a dead plugin.
  timeoutMs: 8000,
  connectTimeoutMs: 700,
};

// The writable parameter vocabulary, mirroring the SONAR_MIXER_PARAM enum in
// cw_surface.c. Kept here as well so a caller can validate an argument without
// a round trip, and so a typo is caught before it becomes a silent no-op.
export const SURFACE_PARAMS = Object.freeze({
  VOL: { value: 0, kind: 'scalar', note: '0..1 continuous, not the 0..127 CC7 range' },
  PAN: { value: 1, kind: 'scalar', note: '-1..1, not the 0..127 CC10 range' },
  MUTE: { value: 2, kind: 'bool' },
  SOLO: { value: 3, kind: 'bool' },
  ARCHIVE: { value: 4, kind: 'bool' },
  RECORD_ARM: { value: 5, kind: 'bool' },
  VOL_TRIM: { value: 6, kind: 'scalar' },
  PHASE: { value: 7, kind: 'bool' },
  INPUT: { value: 10, kind: 'int', note: 'input port index' },
  OUTPUT: { value: 12, kind: 'int', note: 'output port index' },
  BANK: { value: 14, kind: 'int' },
  PATCH: { value: 15, kind: 'int' },
  KEY_OFFSET: { value: 16, kind: 'int' },
  VEL_OFFSET: { value: 17, kind: 'int' },
  SELECTED: { value: 18, kind: 'bool' },
  SEND_ENABLE: { value: 19, kind: 'bool' },
  SEND_VOL: { value: 21, kind: 'scalar' },
  SEND_PAN: { value: 22, kind: 'scalar' },
  INPUT_ECHO: { value: 36, kind: 'bool' },
  FX: { value: 26, kind: 'int', note: 'FX bin slot' },
  FX_PARAM: { value: 29, kind: 'int', note: 'parameter of the slot named by FX' },
});

export function isKnownParam(name) {
  return Object.prototype.hasOwnProperty.call(SURFACE_PARAMS, String(name).toUpperCase());
}

// Coerce a caller's value into the integer the protocol carries, and refuse
// anything that would silently mean something else. A boolean must not go in as
// 0/1 by accident of JavaScript, and a string number is a caller bug.
export function encodeValue(paramName, input) {
  const key = String(paramName).toUpperCase();
  const def = SURFACE_PARAMS[key];
  if (!def) throw new Error(`unknown surface parameter: ${paramName}`);

  if (def.kind === 'bool') {
    if (typeof input === 'boolean') return input ? 1 : 0;
    if (typeof input === 'number' && (input === 0 || input === 1)) return input;
    throw new Error(`${key} takes a boolean, got ${JSON.stringify(input)}`);
  }

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${key} takes a number, got ${JSON.stringify(input)}`);
  }

  if (def.kind === 'scalar') {
    // VOL and PAN are the two that differ from the MIDI CC range people expect,
    // so they get an explicit range check rather than a silent truncation.
    const lo = key === 'PAN' ? -1 : 0;
    const hi = 1;
    if (input < lo || input > hi) {
      throw new Error(`${key} must be ${lo}..${hi} (got ${input}); this is the mixer value, not a CC`);
    }
    // The plugin takes an integer; scale to a 0..1000 range so a caller's 0.5
    // survives the trip with useful precision.
    return key === 'PAN'
      ? Math.round((input + 1) * 500)
      : Math.round(input * 1000);
  }

  if (!Number.isInteger(input)) throw new Error(`${key} takes an integer, got ${input}`);
  return input;
}

// ------------------------------------------------------------------ client --

let socket = null;
let buffer = '';
let pending = [];
let connecting = null;

function rejectAll(err) {
  const waiting = pending;
  pending = [];
  for (const p of waiting) p.reject(err);
}

/**
 * Tear down the connection and settle EVERY pending waiter with `err`.
 *
 * This never leaves a waiter hanging: a request whose socket is gone can never
 * be answered, so settling it now is the only honest outcome. Callers that tear
 * the connection down on purpose (closeSurfaceClient, a write failure) pass an
 * error; the socket-level handlers pass the real reason.
 */
function detach(err) {
  if (socket) {
    socket.removeAllListeners();
    try { socket.destroy(); } catch { /* already gone */ }
    socket = null;
  }
  buffer = '';
  connecting = null;
  rejectAll(err || new Error('control-surface client was closed before the request was answered'));
}

// ------------------------------------------------------------------- auth ----
//
// The plugin may be started in an "authenticated" mode, where every request has
// to carry a shared secret. The secret lives in the SAME environment the MCP
// server runs in (CW_SURFACE_TOKEN) and is never defaulted, never guessed and
// never logged: a missing or malformed token is a configuration error, reported
// before any connection is attempted, so it cannot be mistaken for "the plugin
// is not loaded".

const SURFACE_AUTH_ENV = 'CW_SURFACE_TOKEN';
const SURFACE_AUTH_SHAPE = /^[0-9a-fA-F]{64}$/;

/** The configured token, or throws SURFACE_AUTH_REQUIRED before connecting. */
function surfaceToken() {
  const raw = process.env[SURFACE_AUTH_ENV];
  if (raw === undefined || raw === null || raw.trim() === '') {
    const err = new Error(
      `${SURFACE_AUTH_ENV} is not set — this client is not configured for the control-surface `
      + 'bridge, so no connection was attempted. Set it in the same environment as this MCP '
      + 'server to the 64-hex-character token the plugin was started with.'
    );
    // Never echo the value here; only ever say that it is absent or malformed.
    err.code = 'SURFACE_AUTH_REQUIRED';
    err.configuration = true;
    throw err;
  }
  // The raw string IS the token: no trimming, ever. The native side hashes the
  // exact bytes it was started with, so accepting "  64 hex  " here would
  // authenticate with something the plugin never saw. Whitespace is a
  // malformation, not a convenience to be normalised away.
  if (typeof raw !== 'string' || !SURFACE_AUTH_SHAPE.test(raw)) {
    const err = new Error(
      `${SURFACE_AUTH_ENV} is malformed — expected exactly 64 hexadecimal characters, got `
      + `${raw.length} character(s). No connection was attempted.`
    );
    err.code = 'SURFACE_AUTH_REQUIRED';
    err.configuration = true;
    throw err;
  }
  return raw;
}

// ----------------------------------------------------------------- guard -----
//
// Raw host-memory introspection and host-slot probing were withdrawn after they
// crashed SONAR with C0000005. Reinstating them is a deliberate product
// decision, not something a caller can request at runtime, so these operations
// are refused permanently — case-insensitively, and BEFORE any connection is
// opened, so a refused request cannot touch the host at all.

const SURFACE_DISABLED_OPS = new Set(['read', 'dump', 'call', 'qi', 'probe']);

function surfaceDisabledOp(message) {
  if (!message || typeof message !== 'object') return null;
  const op = typeof message.op === 'string' ? message.op.trim().toLowerCase() : '';
  return SURFACE_DISABLED_OPS.has(op) ? op : null;
}

function surfaceDiagnosticDisabled(op) {
  const err = new Error(
    `control-surface operation ${JSON.stringify(op)} is permanently disabled — raw host-memory `
    + 'reads and host-slot probing were withdrawn after they crashed the host. Nothing was sent.'
  );
  err.code = 'SURFACE_DIAGNOSTIC_DISABLED';
  err.permanentlyDisabled = true;
  return err;
}

function ensureSocket() {
  if (socket && !socket.destroyed) return Promise.resolve(socket);
  if (connecting) return connecting;

  connecting = new Promise((resolve, reject) => {
    const s = netConnect({ host: SURFACE_BRIDGE.host, port: SURFACE_BRIDGE.port });
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      detach();
      reject(err);
    };

    s.setTimeout(SURFACE_BRIDGE.connectTimeoutMs);
    s.once('connect', () => {
      if (settled) return;
      settled = true;
      s.setTimeout(0);
      socket = s;
      connecting = null;
      s.setEncoding('utf8');
      s.on('data', onData);
      s.on('error', (e) => detach(e));
      s.on('close', () => detach(new Error('surface bridge closed the connection')));
      resolve(s);
    });
    s.once('timeout', () => fail(new Error('surface bridge did not accept a connection')));
    s.once('error', (e) => fail(e));
  });

  return connecting;
}

function onData(chunk) {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const p = pending.shift();
    if (!p) continue;         // a reply with no waiter: a stray, ignore it
    clearTimeout(p.timer);
    try {
      p.resolve(JSON.parse(line));
    } catch (e) {
      p.reject(new Error(`surface bridge sent unparseable JSON: ${line.slice(0, 200)}`));
    }
  }
}

/**
 * A copy of `message` with any token-bearing property removed, for use in
 * error text.
 *
 * The bridge adds the token to the wire copy itself, so the caller's object
 * should never carry one — but "should" is not a guarantee, and a caller that
 * does pass `{ token }` must not get it echoed back inside a timeout message.
 * The whole key is dropped (not just its value) so nothing under that name can
 * reach a printed error.
 */
function redactToken(message) {
  if (!message || typeof message !== 'object') return message;
  const safe = {};
  for (const [k, v] of Object.entries(message)) {
    if (k.toLowerCase().includes('token')) continue;   // token, authToken, tokenX…
    safe[k] = v;
  }
  return safe;
}

/**
 * Send one request and return the parsed reply.
 *
 * The protocol is strictly one request, one reply, in order — the plugin
 * answers synchronously per line — so a FIFO of waiters is enough and no
 * request ids are needed.
 *
 * A connection failure is re-thrown as SURFACE_UNREACHABLE with the address in
 * the message, because "ECONNREFUSED" on its own reads like a bug in the
 * caller rather than "the plugin is not loaded".
 */
export async function surfaceCall(message, { timeoutMs = SURFACE_BRIDGE.timeoutMs } = {}) {
  // Both refusals happen BEFORE the socket is touched. A raw diagnostic op is
  // withdrawn outright; a missing or malformed token is a configuration error.
  // Either way nothing is dialled and nothing reaches the host, so a caller
  // cannot misread the outcome as "the plugin is not loaded".
  const disabledOp = surfaceDisabledOp(message);
  if (disabledOp) throw surfaceDiagnosticDisabled(disabledOp);
  const token = surfaceToken();

  let s;
  try {
    s = await ensureSocket();
  } catch (e) {
    const err = new Error(
      `control-surface plugin is not reachable on ${SURFACE_BRIDGE.host}:${SURFACE_BRIDGE.port} — ${e.message}`
    );
    err.code = 'SURFACE_UNREACHABLE';
    err.cause = e;
    throw err;
  }

  // The token goes on the wire LAST, and the caller's object is copied rather
  // than extended, so a caller that reuses its request object never ends up
  // carrying the secret around.
  const wire = { ...message, token };
  const line = JSON.stringify(wire) + '\n';
  // For error messages: the caller's message with any token property stripped,
  // never the wire copy. A caller that passes {token} itself must still not be
  // able to get that value — or any value under that key — into an error the
  // bridge prints, so the key is removed rather than trusted to be absent.
  const displayable = redactToken(message);
  const forDisplay = JSON.stringify(displayable);

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };

    waiter.timer = setTimeout(() => {
      const i = pending.indexOf(waiter);
      if (i < 0) return;                 // already settled by a teardown
      const err = new Error(
        `control-surface plugin did not answer within ${timeoutMs}ms on ${forDisplay}`
      );
      err.code = 'SURFACE_TIMEOUT';
      // A timed-out request poisons the connection: the plugin may still send
      // its reply, and the FIFO would hand that late reply to the NEXT waiter.
      // So drop the socket and fail every waiter rather than answer B to A.
      detach(err);
    }, timeoutMs);

    pending.push(waiter);
    s.write(line, (err) => {
      if (!err) return;
      const e = new Error(`control-surface write failed: ${err.message}`);
      e.code = 'SURFACE_UNREACHABLE';
      // The stream is unusable after a write error and the queued bytes will
      // never be answered, so detach — which settles this waiter and the rest.
      detach(e);
    });
  });
}

/** Is the bridge reachable at all — i.e. is the DLL loaded inside SONAR? */
export async function bridgeAlive() {
  try {
    const r = await surfaceCall({ op: 'ping' }, { timeoutMs: SURFACE_BRIDGE.connectTimeoutMs + 300 });
    return !!(r && r.ok && r.pong);
  } catch {
    return false;
  }
}

/**
 * A status report shaped for a human, not a raw dump.
 *
 * `state` is the load-bearing field:
 *   not-installed  the DLL is not loaded in SONAR at all
 *   needs-user-setup  DLL loaded, but SONAR has not called Connect — the user
 *                     has to add the surface in Preferences
 *   ready          Connect has happened and writes will land
 */
export async function surfaceStatus() {
  const base = {
    host: SURFACE_BRIDGE.host,
    port: SURFACE_BRIDGE.port,
    bridge_reachable: false,
    connected: false,
    state: 'not-installed',
    detail: '',
    actions: [],
  };

  let ping;
  try {
    ping = await surfaceCall({ op: 'ping' }, { timeoutMs: 1000 });
  } catch (e) {
    if (e.configuration) {
      base.state = 'not-configured';
      base.detail = e.message;
      base.actions = ['Optional component: no connection was attempted. Only when deliberately '
        + 'enabling diagnostics, configure the same CW_SURFACE_TOKEN in SONAR and MCP.'];
      return base;
    }
    base.detail = `No listener on ${SURFACE_BRIDGE.host}:${SURFACE_BRIDGE.port} — ${e.message}`;
    base.actions = [
      'Build the plugin: native/surface/build.cmd',
      'Install it:     native/surface/install.ps1',
      'Then restart SONAR.',
    ];
    return base;
  }
  if (!ping || !ping.ok) {
    base.detail = 'Something answered on the port but did not speak the protocol.';
    base.actions = ['Check for another process using this port, or set CW_SURFACE_PORT.'];
    return base;
  }

  base.bridge_reachable = true;

  const st = await surfaceCall({ op: 'status' }, { timeoutMs: 2000 });
  base.connected = !!st.connected;
  base.refs = st.refs;
  base.refresh_calls = st.refresh;
  base.sets_ok = st.sets;
  base.sets_failed = st.failures;

  if (st.connected) {
    base.state = 'ready';
    base.detail = 'SONAR handed the plugin its mixer context; writes will land.';
  } else {
    base.state = 'needs-user-setup';
    base.detail = 'The plugin is loaded, but SONAR has not called Connect yet, so it '
      + 'has no track context and every write is refused.';
    base.actions = [
      'In SONAR open 偏好设置 > MIDI > 控制面板 (Preferences > MIDI > Control Surfaces).',
      'Add "Cakewalk MCP Surface Bridge" to the list and OK the dialog.',
      'Re-run this status to confirm state becomes "ready".',
    ];
  }
  return base;
}

/** Set one parameter on one track. Throws on a refusal, with the plugin's reason. */
export async function surfaceSet(track, param, value) {
  if (!Number.isInteger(track) || track < 0) {
    throw new Error(`track must be a non-negative integer, got ${JSON.stringify(track)}`);
  }
  const name = String(param).toUpperCase();
  const encoded = encodeValue(name, value);

  let r;
  try {
    r = await surfaceCall({ op: 'set', track, param: name, value: encoded });
  } catch (e) {
    // surfaceCall already classified this; pass it through rather than
    // re-wrapping, which doubled the wording in the message.
    throw e;
  }

  if (!r.ok) {
    const err = new Error(r.error || 'surface refused the write');
    err.code = 'SURFACE_REFUSED';
    err.detail = r;
    err.needsUserSetup = /not connected/i.test(r.error || '');
    throw err;
  }
  return r;
}

/** The plugin's own diagnostics — the four things only a live host can answer. */
export async function surfaceDiag() {
  return surfaceCall({ op: 'diag' });
}

/** The parameter vocabulary as the plugin itself defines it. */
export async function surfaceParams() {
  return surfaceCall({ op: 'params' });
}

/**
 * Read the host object's memory, without calling anything.
 *
 * The safe half of introspection. `dump` starts at the object itself; `read`
 * takes an absolute address, so a caller can follow a pointer it found. Both are
 * read-only: nothing is invoked, so nothing can diverge — which is the property
 * the slot-probing route did not have, and why that route crashed the host.
 *
 * Addresses arrive as hex strings and are converted to BigInt here, because a
 * 64-bit pointer does not survive the trip as a JSON number.
 */
function parseQwords(reply) {
  return (reply.qwords || []).map((q) => ({
    offset: q.i * 8,
    address: q.v,
    value: BigInt(q.v),
    module: q.module || null,
  }));
}

export async function surfaceDump({ offset = 0, count = 24 } = {}) {
  const r = await surfaceCall({ op: 'dump', offset, count });
  return { ...r, qwords: parseQwords(r) };
}

export async function surfaceRead(addr, { count = 12 } = {}) {
  // Accept a BigInt, a hex string, or a number.
  const a = typeof addr === 'bigint' ? addr : BigInt(addr);
  const r = await surfaceCall({ op: 'read', addr: '0x' + a.toString(16), count });
  return { ...r, qwords: parseQwords(r) };
}

/**
 * MIDI that SONAR forwarded to the surface plugin.
 *
 * This is the one part of the surface mechanism that turned out to be a working
 * two-way channel, and it took a wrong assumption to find. The surface interface
 * looked like it should let a plugin PUSH values into SONAR (`SetTargetParam`,
 * `SetBaseTrack`), but disassembling the shipped plugin showed that direction is
 * the opposite: those are the host telling the SURFACE what changed, so the
 * surface can update its own LEDs and faders. The surface's own
 * `SetParamMidiMsg`, which would declare a mapping, is compiled to
 * `return E_NOTIMPL` in the shipped implementation.
 *
 * What does work is MIDI. Once the surface is assigned the right INPUT port in
 * Preferences, SONAR feeds every message that arrives on that port straight to
 * `IControlSurface::MidiInShortMsg`. Measured: 11 messages sent to the loopback
 * port came back 11 times, with status, data bytes and arrival tick.
 *
 * The USE of this is left to the caller: a surface that wants to act on a track
 * has to decide what each message means. This tool reports what arrived, which
 * is the half that had never been confirmed before.
 */
export async function surfaceMidiIn() {
  const r = await surfaceCall({ op: 'midi' });
  return {
    ...r,
    // Decode the raw status nibble so a caller does not have to.
    decoded: (r.events || []).map((e) => {
      const status = Number(e.status);
      const kind = status & 0xF0;
      const ch = (status & 0x0F) + 1;
      const type = kind === 0x90 ? 'noteOn'
        : kind === 0x80 ? 'noteOff'
        : kind === 0xB0 ? 'controlChange'
        : kind === 0xC0 ? 'programChange'
        : kind === 0xE0 ? 'pitchBend'
        : kind === 0xA0 ? 'aftertouch'
        : kind === 0xD0 ? 'channelPressure'
        : 'other';
      return {
        type,
        channel: ch,
        control: type === 'controlChange' ? e.d1 : undefined,
        value: e.d2,
        data1: e.d1,
        tick: e.tick,
      };
    }),
  };
}

/**
 * Drop the client socket. The plugin keeps running; this is not a shutdown.
 *
 * Detaching always settles the waiters too, so a caller cannot be left with a
 * promise that will never resolve just because the client was closed under it.
 */
export function closeSurfaceClient() {
  const err = new Error('control-surface client was closed before the request was answered');
  err.code = 'SURFACE_CLOSED';
  detach(err);
}

export function surfaceHelp() {
  return {
    what: 'The control-surface bridge reaches track properties that neither CAL nor the '
      + 'menu commands can: MUTE, SOLO, RECORD_ARM, INPUT, OUTPUT, BANK, PATCH and the FX bin.',
    why: 'SONAR finds control surfaces by scanning its Shared Surfaces folder and '
      + 'CoCreateInstance-ing each DLL, with no allowlist and no signature check, so a '
      + 'surface plugin is an ordinary supported extension point rather than a bypass.',
    architecture: {
      plugin: 'native/surface/cw_surface.c — implements IControlSurface3 (44-slot vtable, '
        + 'derived from IDispatch) and runs a worker thread inside SONAR.',
      transport: 'Line-delimited JSON over loopback TCP 127.0.0.1:39177. Loopback rather '
        + 'than a named pipe so an elevation mismatch between SONAR and Node cannot break it.',
      client: 'this module.',
    },
    protocol: {
      status: '{"op":"status"} -> connection state and counters',
      set: '{"op":"set","track":N,"param":"MUTE","value":1}',
      params: '{"op":"params"} -> the writable vocabulary',
      diag: '{"op":"diag"} -> IIDs the host answered to, RefreshSurface cadence, last error',
      ping: '{"op":"ping"} -> liveness',
    },
    howToInstall: [
      'native/surface/build.cmd          (needs mingw gcc; produces build/cw_surface.dll)',
      'powershell -File native/surface/install.ps1',
      'Restart SONAR, then add the surface in Preferences > MIDI > Control Surfaces.',
    ],
    howToVerify: 'cw_surface_status reports state "ready" once SONAR has called Connect. '
      + 'Before that it reports "needs-user-setup", which is a normal setup state and not an error.',
    whatTheHostActuallyIs: {
      summary: 'The object SONAR passes to Connect is CCtrlSurface. Its class name and the '
        + 'three interfaces it implements were recovered by static analysis of Sonar.exe, '
        + 'not by guessing IIDs — which is what the earlier rounds did, and why they failed.',
      chain: [
        'Absolute addresses from the plugin log minus the module base gave the vtable RVA exactly.',
        'That RVA is in .rdata; [vtable-8] is an MSVC RTTICompleteObjectLocator.',
        'Following it to the TypeDescriptor yielded the class name: .?AVCCtrlSurface@@.',
        'Its ClassHierarchyDescriptor showed the bases, including CMidiInputMonitor::CObserver — '
          + 'so the object is a MIDI-input observer that feeds a surface.',
        'Disassembling slot 0 showed it IS QueryInterface (mov rax,[rdx] then IID compares).',
        'The three IIDs it compares against all now return S_OK.',
      ],
      acceptedInterfaces: [
        '{ED0C14F0-40F3-4459-813C-CB5B5A5E4958}  -> S_OK',
        '{85F8BB17-75F8-497F-8319-EF33A632C380}  -> S_OK',
        '{55507DE1-C037-4682-A4EC-65B1D2E86B53}  -> S_OK',
      ],
      theLesson: 'A QueryInterface miss is evidence about the IID you tried, never about the '
        + 'object. Four E_NOINTERFACE results were misread as "the host has no usable '
        + 'interface", and that wrong generalisation cost a full round of work.',
    },
    currentLimits: [
      'Requires the one-time user step of adding the surface in Preferences; the plugin '
        + 'cannot add itself to that list.',
      'THE OPEN PROBLEM: which slot of which accepted interface is SetBaseTrack and which is '
        + 'SetTargetParam. Three interfaces are addressable (5, 6 and 8 methods) and none is '
        + 'the 59-method CSonarMixer. Their slots 0-2 are forwarding thunks and the rest read '
        + 'as connect/register work, so the mapping needs the type library (SURFACEFRAMELib, '
        + 'absent from disk) or more disassembly.',
      'Do NOT try to identify those slots by calling them. That was attempted with thread '
        + 'isolation and a timeout, which protected the bridge but not the host: SONAR died '
        + 'with C0000005 and wrote a minidump. All that probing code has been removed.',
      'GetTargetParam (reading a value back) is stubbed — the reply shape for it was not '
        + 'among the recovered signatures, so reads are not offered rather than guessed.',
      'The numeric scaling for VOL and PAN is this adapter\'s own convention (0..1000); '
        + 'the plugin passes it straight through to SetTargetParam.',
    ],
  };
}
