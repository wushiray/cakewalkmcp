// test/convert.test.mjs — time-unit conversion.
//
// All of this is arithmetic, so it is testable exhaustively and there is no
// excuse for an approximate assertion. The cases that matter are the boundaries
// and the round trips:
//
//   - bar and beat are 1-based, the tick field is 0-based. Getting this wrong by
//     one is the most likely mistake a caller makes, so both directions are
//     pinned at the boundary.
//   - a round trip must be lossless, or a caller reading a position and writing
//     it back moves the playhead.
//   - a non-4/4 time signature changes what a bar is, and the arithmetic has to
//     follow it rather than assume 4/4.
//   - seconds depend on tempo, ticks do not; a conversion that ignores that is
//     wrong in a way which only shows up at another tempo.
//
// NOTE ON THE API SHAPE. `parseBarBeatTick` and `formatBarBeatTick` return
// OBJECTS, not bare numbers: the parser returns { tick, bar, beat, sub } and the
// formatter returns { text, bar, beat, sub, timeSig }. That is deliberate — the
// structured form is what lets a caller keep the components without re-parsing —
// and it is recorded here because the first version of this file assumed plain
// numbers and every assertion failed against the real module.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PPQ, beatsPerBar, parseBarBeatTick, formatBarBeatTick,
  ticksToSeconds, secondsToTicks, formatSeconds, parseSeconds,
  convert, NOTE_VALUES, convertHelp,
} from '../lib/convert.js';

describe('PPQ and bars', () => {
  test('one bar of 4/4 is 1920 ticks at 480 PPQ', () => {
    assert.equal(PPQ, 480);
    const b = beatsPerBar([4, 4]);
    assert.equal(b.ticksPerBar, 1920, '4 beats x 480 ticks');
    assert.equal(b.numerator, 4);
    assert.equal(b.denominator, 4);
  });

  test('a denominator other than 4 changes the bar length', () => {
    // 6/8 is six eighth-notes = 6 * (480*4/8) = 1440 ticks, NOT 2880.
    assert.equal(beatsPerBar([6, 8]).ticksPerBar, 1440);
    // 3/4 is three quarter-notes = 1440 too, but for a different reason —
    // pinned separately so a bug that happens to agree on 6/8 is still caught.
    assert.equal(beatsPerBar([3, 4]).ticksPerBar, 1440);
    // 2/2 is two half-notes = 1920.
    assert.equal(beatsPerBar([2, 2]).ticksPerBar, 1920);
    // 7/8 is seven eighths = 1680.
    assert.equal(beatsPerBar([7, 8]).ticksPerBar, 1680);
  });

  test('defaults to 4/4 when no signature is given', () => {
    assert.equal(beatsPerBar().ticksPerBar, 1920);
    assert.equal(beatsPerBar([]).ticksPerBar, 1920);
  });

  test('a degenerate signature falls back per field, not wholesale', () => {
    // Each field is sanitised on its own: a bad numerator becomes 4 while a
    // valid denominator is kept. So [NaN, 2] is 4/2 (four half-notes = 3840
    // ticks), NOT 4/4. Written out because the first version of this test
    // assumed a whole-signature fallback and was wrong about the module.
    assert.equal(beatsPerBar([0, 0]).ticksPerBar, 1920, 'both bad -> 4/4');
    assert.equal(beatsPerBar([NaN, 2]).ticksPerBar, 3840, 'numerator bad -> 4, denominator 2 kept');
    assert.equal(beatsPerBar([4, NaN]).ticksPerBar, 1920, 'denominator bad -> 4');
    assert.equal(beatsPerBar([NaN, NaN]).ticksPerBar, 1920);
    // The point of the guard: nothing produces Infinity or NaN.
    for (const sig of [[0, 0], [NaN, 2], [4, 0], [-1, 4], [4, -2]]) {
      assert.ok(Number.isFinite(beatsPerBar(sig).ticksPerBar),
        `${JSON.stringify(sig)} produced a non-finite bar length`);
    }
  });
});

describe('bar:beat:tick parsing', () => {
  test('the first position is 1:01:000 and is tick 0', () => {
    const r = parseBarBeatTick('1:01:000');
    assert.equal(r.tick, 0);
    assert.equal(r.bar, 1);
    assert.equal(r.beat, 1);
    assert.equal(r.sub, 0);
  });

  test('bar and beat are 1-based, the tick field is 0-based', () => {
    // This asymmetry is the trap.
    assert.equal(parseBarBeatTick('1:02:000').tick, 480, 'beat 2 of bar 1');
    assert.equal(parseBarBeatTick('2:01:000').tick, 1920, 'bar 2');
    assert.equal(parseBarBeatTick('1:01:480').tick, 480, 'a 480-tick offset is beat 2');
  });

  test('an offset tick pushes into the next beat correctly', () => {
    assert.equal(parseBarBeatTick('1:02:479').tick, 959);
    assert.equal(parseBarBeatTick('1:02:480').tick, 960);
  });

  test('a non-4/4 signature changes where bar 2 begins', () => {
    const opts = { timeSig: [3, 4] };
    assert.equal(parseBarBeatTick('2:01:000', opts).tick, 1440, 'a 3/4 bar is 1440 ticks');
    assert.equal(parseBarBeatTick('1:04:000', opts).tick, 1440, 'beat 4 of 3/4 == bar 2');
  });

  test('a bare number means a BAR number, not ticks', () => {
    // Guessing here would make "5" and "5 ticks" indistinguishable.
    assert.equal(parseBarBeatTick(5).tick, 4 * 1920);
    assert.equal(parseBarBeatTick(1).tick, 0);
  });

  test('a bare number below 1 is refused', () => {
    assert.throws(() => parseBarBeatTick(0), /bar number must be >= 1/);
    assert.throws(() => parseBarBeatTick(-2), /bar number must be >= 1/);
  });

  test('accepts the looser forms a caller is likely to type', () => {
    assert.equal(parseBarBeatTick('1:1:0').tick, 0);
    assert.equal(parseBarBeatTick('  1:01:000  ').tick, 0);
    assert.equal(parseBarBeatTick('1.02.000').tick, 480, 'dots work as separators too');
    // Two fields is read as bar:beat with no sub-tick, which is what the
    // time-signature form `1:02` means. Recorded because it is a real accepted
    // form rather than an error, and a caller relying on strictness would be
    // surprised.
    assert.equal(parseBarBeatTick('1:02').tick, 480);
    assert.equal(parseBarBeatTick('2:01').tick, 1920);
  });

  test('rejects malformed input instead of guessing', () => {
    // A silent default here would move the now-time somewhere arbitrary and
    // look like a transport bug rather than an input error.
    for (const bad of ['', 'abc', '1:01:00:00', 'x:01:000', null, undefined]) {
      assert.throws(() => parseBarBeatTick(bad), (e) => e.code === 'BAD_TIME',
        `should reject ${JSON.stringify(bad)} with BAD_TIME`);
    }
  });
});

describe('bar:beat:tick formatting', () => {
  test('tick 0 formats as 1:01:000', () => {
    assert.equal(formatBarBeatTick(0).text, '1:01:000');
  });

  test('the tick field is zero-padded to three digits and the beat to two', () => {
    assert.equal(formatBarBeatTick(1).text, '1:01:001');
    assert.equal(formatBarBeatTick(479).text, '1:01:479');
    assert.equal(formatBarBeatTick(480).text, '1:02:000');
  });

  test('the components are returned alongside the text', () => {
    const r = formatBarBeatTick(1920 + 960 + 5);
    assert.equal(r.bar, 2);
    assert.equal(r.beat, 3);
    assert.equal(r.sub, 5);
    assert.deepEqual(r.timeSig, [4, 4]);
  });

  test('a negative tick is clamped to the start rather than going before bar 1', () => {
    assert.equal(formatBarBeatTick(-500).text, '1:01:000');
  });

  test('formatting and parsing round-trip losslessly', () => {
    // A caller that reads a position and writes it back must not move anything.
    for (const tick of [0, 1, 479, 480, 1919, 1920, 1921, 4800, 15360, 123456]) {
      const s = formatBarBeatTick(tick).text;
      assert.equal(parseBarBeatTick(s).tick, tick, `round trip failed at ${tick} (${s})`);
    }
  });

  test('the round trip holds under a non-4/4 signature too', () => {
    const opts = { timeSig: [7, 8] };
    for (const tick of [0, 1, 239, 240, 1679, 1680, 1681, 20000]) {
      const s = formatBarBeatTick(tick, opts).text;
      assert.equal(parseBarBeatTick(s, opts).tick, tick, `round trip failed at ${tick} (${s})`);
    }
  });
});

describe('seconds', () => {
  test('at 120 bpm a beat is half a second', () => {
    assert.equal(ticksToSeconds(480, { bpm: 120 }), 0.5);
    assert.equal(ticksToSeconds(1920, { bpm: 120 }), 2);
    assert.equal(ticksToSeconds(0, { bpm: 120 }), 0);
  });

  test('tempo changes the answer, and only the seconds answer', () => {
    assert.equal(ticksToSeconds(1920, { bpm: 60 }), 4);
    assert.equal(ticksToSeconds(1920, { bpm: 240 }), 1);
    // The tick count is tempo-independent, which is the point of storing ticks.
    assert.equal(parseBarBeatTick('2:01:000').tick, 1920);
  });

  test('seconds convert back to the same ticks', () => {
    for (const [tick, bpm] of [[0, 120], [480, 120], [1920, 90], [12345, 137.5], [99999, 200]]) {
      const s = ticksToSeconds(tick, { bpm });
      assert.equal(secondsToTicks(s, { bpm }), tick, `round trip failed at ${tick} @ ${bpm}bpm`);
    }
  });

  test('a non-480 PPQ is honoured', () => {
    assert.equal(ticksToSeconds(960, { bpm: 120, ppq: 960 }), 0.5);
  });

  test('a seconds value is refused if it cannot be read', () => {
    assert.throws(() => parseSeconds('not a time'), (e) => e.code === 'BAD_SECONDS');
    assert.throws(() => parseSeconds('1:2:3:4'), (e) => e.code === 'BAD_SECONDS');
  });

  test('formatSeconds emits mm:ss.mmm, gaining an hour field only when needed', () => {
    assert.equal(formatSeconds(0), '0:00.000');
    assert.equal(formatSeconds(1.5), '0:01.500');
    assert.equal(formatSeconds(61.25), '1:01.250');
    assert.equal(formatSeconds(3661.5), '1:01:01.500', 'an hour field appears past 3600s');
  });

  test('parseSeconds reads back what formatSeconds wrote', () => {
    for (const s of [0, 0.5, 1, 1.25, 59.999, 60, 3661.5]) {
      assert.equal(parseSeconds(formatSeconds(s)), s, `failed at ${s}`);
    }
  });

  test('parseSeconds accepts a bare number as seconds', () => {
    assert.equal(parseSeconds(2.5), 2.5);
    assert.equal(parseSeconds('2.5'), 2.5);
  });
});

describe('the convert entry point', () => {
  test('converts a tick position into every other unit', () => {
    const r = convert({ ticks: 1920 }, { bpm: 120 });
    assert.equal(r.source, 'ticks');
    assert.equal(r.tick, 1920);
    assert.equal(r.ticks, 1920);
    assert.equal(r.time, '2:01:000');
    assert.equal(r.seconds, 2);
    assert.equal(r.bar, 2);
    assert.equal(r.ticksPerBar, 1920);
  });

  test('a bar:beat:tick position converts to ticks and seconds', () => {
    const r = convert({ time: '2:01:000' }, { bpm: 120 });
    assert.equal(r.source, 'time');
    assert.equal(r.tick, 1920);
    assert.equal(r.seconds, 2);
  });

  test('a bar number converts', () => {
    const r = convert({ bar: 2 }, { bpm: 120 });
    assert.equal(r.source, 'bar');
    assert.equal(r.tick, 1920);
  });

  test('a seconds value converts to ticks', () => {
    const r = convert({ seconds: 2 }, { bpm: 120 });
    assert.equal(r.source, 'seconds');
    assert.equal(r.tick, 1920);
    assert.equal(r.time, '2:01:000');
  });

  test('the tempo is echoed so the seconds value can be trusted', () => {
    const r = convert({ ticks: 480 }, { bpm: 90 });
    assert.equal(r.bpm, 90);
    assert.deepEqual(r.timeSig, [4, 4]);
    assert.equal(r.ppq, 480);
  });

  test('a nonsensical bpm falls back to 120 rather than producing Infinity', () => {
    const r = convert({ ticks: 480 }, { bpm: 0 });
    assert.equal(r.bpm, 120);
    assert.ok(Number.isFinite(r.seconds));
  });

  test('refuses more than one input rather than picking one', () => {
    // Silently choosing would convert the wrong thing and look like it worked.
    assert.throws(() => convert({ ticks: 0, bar: 2 }), (e) => e.code === 'AMBIGUOUS_INPUT');
  });

  test('refuses an empty request', () => {
    assert.throws(() => convert({}), (e) => e.code === 'NOTHING_TO_CONVERT');
  });

  test('says out loud that seconds assume a constant tempo', () => {
    // With tempo changes the tick and bar values stay exact and the seconds
    // value is only valid within the segment — that has to be stated, not
    // implied.
    const r = convert({ ticks: 0 }, { bpm: 120 });
    assert.match(r.note, /tempo/i);
  });
});

describe('the note-value table', () => {
  test('a whole note is one bar of 4/4', () => {
    assert.equal(NOTE_VALUES['1/1'], 1920);
  });

  test('each halving halves the tick count', () => {
    assert.equal(NOTE_VALUES['1/2'], 960);
    assert.equal(NOTE_VALUES['1/4'], 480);
    assert.equal(NOTE_VALUES['1/8'], 240);
    assert.equal(NOTE_VALUES['1/16'], 120);
    assert.equal(NOTE_VALUES['1/32'], 60);
  });

  test('dotted values are one and a half times the base', () => {
    assert.equal(NOTE_VALUES['1/4D'], 720, '480 * 1.5');
    assert.equal(NOTE_VALUES['1/8D'], 360);
    assert.equal(NOTE_VALUES['1/16D'], 180);
  });

  test('triplets are two thirds of the base', () => {
    // 480 * 2/3 = 320. This is the one people get wrong by using 1/3.
    assert.equal(NOTE_VALUES['1/4T'], 320);
    assert.equal(NOTE_VALUES['1/8T'], 160);
    assert.equal(NOTE_VALUES['1/16T'], 80);
  });
});

describe('the help text', () => {
  test('names the 1-based/0-based trap, since that is the costly mistake', () => {
    const text = JSON.stringify(convertHelp());
    assert.match(text, /1-based|1 based/i);
    assert.ok(text.length > 200, 'the help should carry real content');
  });

  test('says the conversions cannot follow a tempo change', () => {
    const text = JSON.stringify(convertHelp());
    assert.match(text, /tempo/i);
  });
});
