// lib/convert.js — tick / time / bar-beat-tick conversions.
//
// WHY THIS EXISTS
//
// A capability comparison against ACE Studio MCP found it ships a `convert`
// domain (tick-to-time, time-to-tick, tick-to-measure, measure-to-tick,
// editor↔global) and this adapter had nothing, even though almost every other
// tool here speaks or returns ticks. The gap showed up in practice: reading a
// note dump or a marker time meant doing the arithmetic by hand, and the units
// differ between surfaces — the track view shows `1:01:000`, a MIDI export
// carries ticks, and the tempo is beats per minute.
//
// This module is pure arithmetic. It touches no host, spawns nothing, and
// therefore works with SONAR closed — which is the point: a caller can convert
// a measurement it already has without waking anything up.
//
// THE UNITS, BECAUSE THEY ARE NOT OBVIOUS
//
//   tick       SONAR's internal time unit. The project's PPQ is 480 (the value
//              the adapter's own .mid writer emits, and the divisor a SONAR
//              export uses), so one quarter note is 480 ticks.
//   bar:beat:tick   What the Now-time field and the marker dialog display, with
//              the tick field COUNTING IN TICKS, not in a 0-959 subdivision.
//              `1:01:000` is bar 1, beat 1, tick 0 — the very start, and a
//              freshly opened project reads exactly that. Beats and bars are
//              1-based; the tick field is 0-based.
//   seconds    Wall-clock. Derived from the tempo, so it is only meaningful
//              while the tempo is constant — this module assumes one tempo for
//              the whole span, as does SONAR's own linear readout.
//
// The 1-based/0-based split is the trap: only the tick field is 0-based, so
// `2:01:000` is exactly one bar after `1:01:000`, and `1:02:000` is one beat
// after. A parser that treats all three fields as 0-based is off by a bar and a
// beat on every conversion.

/** Ticks per quarter note. Matches lib/midi-file.js PPQ and a SONAR export. */
export const PPQ = 480;

/** Bars are beats; a beat is PPQ ticks. 4/4 is assumed unless a signature is passed. */
export const DEFAULT_TIME_SIG = [4, 4];

/** Beats per bar from a time signature, with a sanity floor of 1. */
export function beatsPerBar(timeSig = DEFAULT_TIME_SIG, { ppq = PPQ } = {}) {
  const [num, den] = Array.isArray(timeSig) ? timeSig : DEFAULT_TIME_SIG;
  // A 4/4 bar is 4 quarter notes; a 6/8 bar is 6 eighth notes = 3 quarters. The
  // bar length in ticks is therefore num * (ppq * 4 / den).
  //
  // The ppq parameter exists because a caller converting a foreign file with a
  // different division needs ONE scale everywhere: the seconds path already took
  // a ppq option, but bar positions stayed pinned to the default 480, so a
  // 960-PPQ conversion reported seconds=2s alongside bar 3 — two answers in one
  // result, each from a different scale (audit finding F4).
  const n = Number.isFinite(num) && num > 0 ? num : 4;
  const d = Number.isFinite(den) && den > 0 ? den : 4;
  const q = Number.isFinite(ppq) && ppq > 0 ? ppq : PPQ;
  return { numerator: n, denominator: d, ticksPerBar: Math.round(n * (q * 4) / d) };
}

/**
 * Parse `bar:beat:tick` into a tick count.
 *
 * Accepts the forms SONAR itself shows and the ones a caller is likely to type:
 * `1:01:000`, `1:1:0`, `3:04:120`, and a bare bar number `5` meaning `5:01:000`.
 * Separators may be `:` or `.`.
 *
 * Returns { tick, bar, beat, sub } or throws with a code, because a silently
 * mis-parsed time would move the now-time to the wrong bar and look like a
 * transport bug rather than an input error.
 */
export function parseBarBeatTick(input, { timeSig = DEFAULT_TIME_SIG, ppq } = {}) {
  const { ticksPerBar, numerator, denominator } = beatsPerBar(timeSig, { ppq });
  if (typeof input === 'number') {
    // A bare number is a BAR number. It is not ticks — a caller with ticks
    // should pass { ticks } to a converter instead, and guessing here would make
    // the two indistinguishable.
    if (!Number.isFinite(input) || input < 1) {
      const e = new Error(`bar number must be >= 1, got ${input}`);
      e.code = 'BAD_BAR';
      throw e;
    }
    return { tick: Math.round((input - 1) * ticksPerBar), bar: input, beat: 1, sub: 0 };
  }
  if (typeof input !== 'string' || !input.trim()) {
    const e = new Error('pass a time as "bar:beat:tick" (e.g. 1:01:000) or a bar number');
    e.code = 'BAD_TIME';
    throw e;
  }
  const parts = input.trim().split(/[:.]/).map((p) => p.trim());
  if (parts.length > 3 || parts.some((p) => p === '' || !/^\d+$/.test(p))) {
    const e = new Error(`cannot read "${input}" as bar:beat:tick`);
    e.code = 'BAD_TIME';
    throw e;
  }
  const bar = Number(parts[0]);
  const beat = parts.length > 1 ? Number(parts[1]) : 1;
  const sub = parts.length > 2 ? Number(parts[2]) : 0;
  if (bar < 1 || beat < 1) {
    const e = new Error(`bar and beat are 1-based, got bar=${bar} beat=${beat} in "${input}"`);
    e.code = 'BAD_TIME';
    throw e;
  }
  // Beat is 1-based, so beat 1 is offset 0 within the bar. The tick field is NOT.
  const tick = Math.round((bar - 1) * ticksPerBar + (beat - 1) * (ticksPerBar / numerator) + sub);
  return { tick, bar, beat, sub, timeSig: [numerator, denominator], ticksPerBar };
}

/** Format a tick count as `bar:beat:tick`, the form SONAR displays. */
export function formatBarBeatTick(tick, { timeSig = DEFAULT_TIME_SIG, ppq } = {}) {
  const { ticksPerBar, numerator, denominator } = beatsPerBar(timeSig, { ppq });
  const t = Math.max(0, Math.round(Number(tick) || 0));
  const ticksPerBeat = ticksPerBar / numerator;
  const bar = Math.floor(t / ticksPerBar) + 1;
  const withinBar = t - (bar - 1) * ticksPerBar;
  const beat = Math.floor(withinBar / ticksPerBeat) + 1;
  const sub = Math.round(withinBar - (beat - 1) * ticksPerBeat);
  return { text: `${bar}:${String(beat).padStart(2, '0')}:${String(sub).padStart(3, '0')}`,
    bar, beat, sub, timeSig: [numerator, denominator] };
}

/** Ticks -> seconds at a constant tempo. */
export function ticksToSeconds(tick, { bpm = 120, ppq = PPQ } = {}) {
  const b = Number(bpm) > 0 ? Number(bpm) : 120;
  return (Math.max(0, Number(tick) || 0) / ppq) * (60 / b);
}

/** Seconds -> ticks at a constant tempo. */
export function secondsToTicks(seconds, { bpm = 120, ppq = PPQ } = {}) {
  const b = Number(bpm) > 0 ? Number(bpm) : 120;
  return Math.round((Math.max(0, Number(seconds) || 0) * b / 60) * ppq);
}

/** Seconds -> `mm:ss.mmm` (or `h:mm:ss.mmm` past an hour), for a readable readout. */
export function formatSeconds(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  // Round the WHOLE value to milliseconds FIRST, then split. The previous
  // version split on floors and rounded only the fractional part, so
  // 59.9996 became secs=59, ms=round(0.9996*1000)=1000 and printed as
  // "0:59.1000" — one tenth of a second off, and re-parsing gave 59.1. The
  // audit's rounding mutation survived the old tests for exactly this reason.
  // Rounding first makes the carry automatic: 59.9996 -> 60000ms -> 1:00.000.
  const totalMs = Math.round(s * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs - h * 3600000) / 60000);
  const secs = Math.floor((totalMs - h * 3600000 - m * 60000) / 1000);
  const ms = totalMs - h * 3600000 - m * 60000 - secs * 1000;
  const lead = h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`;
  return `${lead}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Parse `mm:ss.mmm` / `h:mm:ss` back into seconds. Accepts a bare number as seconds. */
export function parseSeconds(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, input);
  const text = String(input ?? '').trim();
  if (!text) {
    const e = new Error('pass seconds as a number or as "mm:ss.mmm"');
    e.code = 'BAD_SECONDS';
    throw e;
  }
  // A bare numeric string is seconds. Without this case a one-field input fell
  // through to the colon split below and was destructured as
  // [0, ...(nums.length === 2 ? nums : [nums[0]])], which for a single value
  // gives [0, value] — so h=0, m=value, s=undefined and the result was NaN.
  // parseSeconds('2.5') silently returned NaN while parseSeconds(2.5) returned
  // 2.5, so a caller passing a string got a NaN tick position and no error.
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text));

  const parts = text.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) {
    const e = new Error(`cannot read "${text}" as mm:ss.mmm`);
    e.code = 'BAD_SECONDS';
    throw e;
  }
  const nums = parts.map((p) => Number(p.trim()));
  // Right-align the fields: one value is seconds, two are mm:ss, three are
  // h:mm:ss. Written out because the spread that did this was wrong.
  let h = 0, m = 0, s = 0;
  if (nums.length === 3) { [h, m, s] = nums; }
  else if (nums.length === 2) { [m, s] = nums; }
  else { s = nums[0]; }
  return h * 3600 + m * 60 + s;
}

/**
 * The whole conversion in one call — what a caller actually wants.
 *
 * Pass exactly one of `ticks`, `time` (bar:beat:tick), or `seconds`, and get all
 * three representations back plus the tempo and time signature used. Every
 * conversion here is reversible, and a test asserts that round-tripping any
 * representation reproduces the input.
 */
export function convert(input = {}, { bpm = 120, timeSig = DEFAULT_TIME_SIG, ppq = PPQ } = {}) {
  const given = ['ticks', 'time', 'seconds', 'bar'].filter((k) => input[k] !== undefined);
  if (!given.length) {
    const e = new Error('pass one of: ticks, time ("bar:beat:tick"), seconds, or bar');
    e.code = 'NOTHING_TO_CONVERT';
    throw e;
  }
  if (given.length > 1) {
    const e = new Error(`pass only one of ticks / time / seconds / bar, got ${given.join(' + ')} `
      + '— converting from two sources at once would have to guess which wins');
    e.code = 'AMBIGUOUS_INPUT';
    throw e;
  }

  // ppq is a multiplier in every path below. Unchecked, ppq:0 produced
  // seconds:Infinity and a "Infinity:NaN:NaN" display, and a negative ppq
  // produced a negative time that the display then rounded to 0:00.000.
  // bpm keeps its long-standing fallback to 120 (a documented, tested choice).
  const q = Number(ppq);
  if (!Number.isFinite(q) || q <= 0) {
    const e = new Error(`ppq must be a positive finite number, got ${ppq}`);
    e.code = 'BAD_PPQ';
    throw e;
  }
  const sig = Array.isArray(timeSig) ? timeSig : DEFAULT_TIME_SIG;
  if (sig.length !== 2 || !sig.every((n) => Number.isFinite(n) && n > 0)) {
    const e = new Error(`timeSig must be two positive numbers, got ${JSON.stringify(timeSig)}`);
    e.code = 'BAD_TIME_SIG';
    throw e;
  }

  let tick;
  const source = given[0];
  if (source === 'bar' && !Number.isFinite(Number(input.bar))) {
    const e = new Error(`bar must be a finite number, got ${input.bar}`);
    e.code = 'BAD_BAR';
    throw e;
  }
  if (source === 'ticks') {
    const raw = Number(input.ticks);
    if (!Number.isFinite(raw)) {
      const e = new Error(`ticks must be a finite number, got ${input.ticks}`);
      e.code = 'BAD_TICKS';
      throw e;
    }
    tick = Math.max(0, Math.round(raw));
  } else if (source === 'bar') {
    // ppq was dropped here: bar 2 with ppq 960 returned tick 1920, contradicting
    // its own ticksPerBar and time fields.
    tick = parseBarBeatTick(Number(input.bar), { timeSig, ppq: q }).tick;
  } else if (source === 'time') {
    tick = parseBarBeatTick(input.time, { timeSig, ppq: q }).tick;
  } else {
    tick = secondsToTicks(parseSeconds(input.seconds), { bpm, ppq: q });
  }

  // Multiplication above can overflow even when every INPUT is a finite number
  // (bar 1e308, a 400-digit seconds string, timeSig [1, 1e308]). A null/NaN tick
  // used to come back as a successful result.
  if (!Number.isSafeInteger(tick) || tick < 0) {
    const e = new Error(`the converted tick (${tick}) is outside the safe integer range; `
      + 'the input is too large to represent');
    e.code = 'TICK_OUT_OF_RANGE';
    throw e;
  }
  const bbt = formatBarBeatTick(tick, { timeSig, ppq: q });
  const seconds = ticksToSeconds(tick, { bpm, ppq: q });
  // ppq must reach this call too: the round-4 audit found ticks 3840 (correct)
  // reported beside ticksPerBar 1920 for ppq 960.
  const { ticksPerBar, numerator, denominator } = beatsPerBar(timeSig, { ppq: q });
  if (!Number.isFinite(ticksPerBar) || ticksPerBar <= 0) {
    const e = new Error(`the time signature ${JSON.stringify(timeSig)} at ppq ${ppq} gives a `
      + `bar of ${ticksPerBar} ticks`);
    e.code = 'BAD_TIME_SIG';
    throw e;
  }
  return {
    source,
    tick,
    ticks: tick,
    time: bbt.text,
    bar: bbt.bar,
    beat: bbt.beat,
    sub: bbt.sub,
    seconds: Number(seconds.toFixed(6)),
    display: formatSeconds(seconds),
    bpm: Number(bpm) > 0 ? Number(bpm) : 120,
    timeSig: [numerator, denominator],
    ppq: q,
    ticksPerBar,
    note: 'Seconds assume one constant tempo across the span, which is what the transport '
      + 'readout itself assumes. With tempo changes the tick and bar:beat values stay exact and '
      + 'the seconds value is only valid within the segment that holds this bpm.',
  };
}

/** A grid of musical note values in ticks, for callers that think in them. */
export const NOTE_VALUES = {
  '1/1': PPQ * 4, '1/2': PPQ * 2, '1/4': PPQ, '1/8': PPQ / 2, '1/16': PPQ / 4,
  '1/32': PPQ / 8, '1/64': PPQ / 16,
  '1/4T': (PPQ * 2) / 3, '1/8T': PPQ / 3, '1/16T': PPQ / 6,
  '1/4D': PPQ * 1.5, '1/8D': PPQ * 0.75, '1/16D': PPQ * 0.375,
};

/** Everything about this module, for cw_convert_help. */
export function convertHelp() {
  return {
    summary:
      'Tick, bar:beat:tick and seconds conversions. Pure arithmetic — no host, so it works with '
      + 'SONAR closed. Every other tool here speaks or returns ticks, which is why this exists.',
    units: {
      tick: `SONAR's internal unit. PPQ is ${PPQ} in this project, so a quarter note is ${PPQ} ticks.`,
      'bar:beat:tick': 'What the Now-time field and the marker dialog show. BAR AND BEAT ARE '
        + '1-BASED, THE TICK FIELD IS 0-BASED — `1:01:000` is the very start of the project and '
        + 'is what a freshly opened one reads. Mixing the bases is the trap here: it puts every '
        + 'conversion off by a bar and a beat without looking wrong.',
      seconds: 'Derived from the tempo, so only valid across a span with one constant bpm.',
    },
    inputs: 'Pass exactly one of: ticks, time ("1:01:000" or "5:02:120"), seconds ("mm:ss.mmm" '
      + 'or a number), bar (a bar number). Passing two is refused rather than guessed.',
    noteValues: NOTE_VALUES,
    limits: [
      'A constant tempo is assumed, matching the transport readout. Tempo changes need per-segment '
        + 'conversion.',
      'The time signature defaults to 4/4 and only affects bar and beat; ticks are unaffected.',
      'This module cannot read the project tempo — pass it, or take it from cw_timing.',
    ],
  };
}
