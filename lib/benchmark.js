// lib/benchmark.js — measure what this adapter can actually do, and how fast.
//
// The value of a benchmark here is not speed. It is *reachability*: which of the
// operations an agent would want are possible on this build, through which
// transport, and with what confirmation. Several rounds of this work produced
// claims that later turned out to be measurement artefacts (a command called
// "unhandled" because no project was open; a write called "impossible" because
// the element's value goes stale). So every case here states how it is
// confirmed, and the runner reports the confirmation method alongside the
// result — a PASS from "element value changed" and a PASS from "window title
// changed" are not equally strong.
//
// Confirmation strength, strongest first:
//   independent  — a different signal than the one that was written
//   roundtrip    — read the same element back after the action
//   posted       — the command was accepted and nothing errored
//
// Cases are grouped by transport so a failure points at a layer.

import { call } from '../bridge/agent.js';
import { runCommand, liveCommands, closeOverlays, listOverlays } from './menu.js';
import { documentState } from './track-ui.js';
import { pluginSummary, findPlugins } from './plugins.js';
import { midiConfigSummary } from './midi-config.js';
import * as live from './live.js';

const now = () => Date.now();

/** One measured case: run `fn`, time it, classify the result. */
async function measure(name, group, confirmation, fn) {
  const t0 = now();
  let result;
  try {
    result = await fn();
  } catch (e) {
    return {
      name, group, status: 'error', ms: now() - t0, confirmation,
      error: e.message, code: e.code,
    };
  }
  const ms = now() - t0;
  const ok = result && result.ok !== false && result.status !== 'fail';
  return {
    name, group, status: ok ? 'pass' : 'fail', ms, confirmation,
    detail: typeof result === 'string' ? result : (result && result.detail) || undefined,
  };
}

/**
 * Every capability worth knowing about, cheapest first. Nothing here changes the
 * project data: the optional writes toggle views/transport and send MIDI.
 * They can start playback and affect external MIDI destinations. No bus or
 * track is inserted as a measurement.
 */
export async function runBenchmark({ includePluginScan = false, includeMidiSend = true,
  includeWrites = false } = {}) {
  const doc = await documentState();
  const cases = [];
  const skipped = [];

  // ---- reads that need no SONAR interaction ----
  //
  // `read plugin inventory` is the expensive one: it reads SONAR's own scan result
  // and touches 946 registry entries. It used to run unconditionally, OUTSIDE the
  // includePluginScan guard — so the flag only ever controlled the cheap
  // name-filter case, and a caller who passed includePluginScan:false still paid
  // the full cost. Measured: that is what pushed a bare cw_benchmark past 20s.
  // The guard now covers it, and the skip is reported rather than silent.
  if (includePluginScan) {
    cases.push(await measure('read plugin inventory', 'read/static', 'independent', async () => {
      const s = pluginSummary();
      return { ok: s.registered > 0, detail: `${s.registered} registered, ${s.instruments} instruments` };
    }));
    cases.push(await measure('filter plugins by name', 'read/static', 'independent', async () => {
      const r = findPlugins('bass', { limit: 50 });
      return { ok: r.length > 0, detail: `${r.length} matches` };
    }));
  } else {
    skipped.push('read plugin inventory', 'filter plugins by name');
  }
  cases.push(await measure('read MIDI port config', 'read/static', 'independent', async () => {
    const c = midiConfigSummary();
    return { ok: c.exists, detail: `inputs: ${c.input.join(', ') || '(none)'}` };
  }));

  // ---- reads that go through the bridge (Win32) ----
  cases.push(await measure('bridge status', 'read/win32', 'independent', async () => {
    const s = await call('status');
    return { ok: !!s.sonar, detail: s.sonar?.title };
  }));
  cases.push(await measure('read live menu tree', 'read/win32', 'independent', async () => {
    const l = await liveCommands({ refresh: true });
    return { ok: l.length > 0, detail: `${l.length} entries` };
  }));
  cases.push(await measure('detect open document', 'read/win32', 'independent', async () => {
    const d = await documentState();
    return { ok: d.known, detail: d.project || '(no project)' };
  }));
  cases.push(await measure('list modal overlays', 'read/win32', 'independent', async () => {
    const o = await listOverlays();
    // The bridge answers {error} rather than throwing; hard-coding ok:true made
    // "SONAR is closed" count as a passing read.
    if (o && o.error) return { ok: false, detail: o.error };
    return { ok: true, detail: `${(o.overlays || []).length} open` };
  }));

  // ---- writes through the menu transport ----
  //
  // These are the expensive half, and profiling showed why: each posts a command
  // and then WAITS for the UI to settle, so the four of them total ~55s of the
  // sweep's 70s. That is inherent to what they measure — they are proving a write
  // landed, not just that a call returned — so the fix is not to make them faster
  // but to keep them out of the default path. A bare cw_benchmark answers the
  // transport question from the read half; proving the writes is a deliberate act.
  const WRITE_CASE_NAMES = [
    'toggle assistant panel', 'open a view (track view)',
    'transport command accepted',
    'send a note', 'send CC10 pan', 'send a batch',
  ];

  // Document state is read once, outside the write gate, because the result
  // reports it whether or not the writes ran.
  const docIdx = await documentState();

  if (includeWrites) {
  // Toggling the command palette twice proves the transport end to end.
  cases.push(await measure('toggle assistant panel', 'write/menu', 'independent', async () => {
    const before = await listOverlays();
    const wasOpen = (before.overlays || []).some((o) => o.cls?.match(/JUCE/));
    await runCommand(0xA783, { keepOverlays: true });
    await new Promise((r) => setTimeout(r, 1500));
    const after = await listOverlays();
    const isOpen = (after.overlays || []).some((o) => o.cls?.match(/JUCE/));
    const flipped = wasOpen !== isOpen;
    if (isOpen) await closeOverlays();
    return {
      ok: flipped,
      detail: flipped ? `${wasOpen ? 'open' : 'closed'} -> ${isOpen ? 'open' : 'closed'}`
        : `no change (still ${isOpen ? 'open' : 'closed'})`,
    };
  }));

  // Document state is read once, outside the write gate, because the result
  // reports it whether or not the writes ran.
  const docIdx = await documentState();
  if (docIdx.projectOpen) {
    // A window diff cannot see a view that is already open — re-opening Track
    // view when it is showing changes nothing, which reads as a false failure.
    // The honest test for the menu transport is the assistant toggle above; for
    // views we only check that the command is accepted.
    cases.push(await measure('open a view (track view)', 'write/menu', 'posted', async () => {
      const r = await runCommand(0x8294);
      return {
        ok: r.posted === 0x8294,
        detail: `${r.effect} (a diff cannot see a view that is already open)`,
      };
    }));
    cases.push(await measure('transport command accepted', 'write/menu', 'posted', async () => {
      const r = await runCommand(0x801D); // play/stop
      await new Promise((res) => setTimeout(res, 600));
      await runCommand(0x801F);          // stop
      return { ok: r.posted === 0x801D, detail: 'play/stop then stop' };
    }));
  } else {
    cases.push(await measure('open a view (track view)', 'write/menu', 'independent', async () => ({
      ok: false, detail: 'no project open — view commands are document-scoped',
    })));
  }

  // ---- MIDI output ----
  if (includeMidiSend) {
    const st = await live.liveStatus();
    cases.push(await measure('resolve MIDI port', 'write/midi', 'independent', async () => ({
      ok: !!st.selected, detail: st.selected || st.error,
    })));
    cases.push(await measure('SONAR tuned to the cable', 'read/config', 'independent', async () => ({
      ok: st.sonarReceives === true,
      detail: `sonarReceives=${st.sonarReceives} (from TTSSEQ.INI)`,
    })));
    if (st.selected) {
      cases.push(await measure('send one note', 'write/midi', 'posted', async () => {
        const r = await live.playNote({ pitch: 60, velocity: 1, durationMs: 30 });
        return { ok: r.ok, detail: 'C4 at velocity 1' };
      }));
      cases.push(await measure('send a CC', 'write/midi', 'posted', async () => {
        const r = await live.sendCC(1, 10, 64);
        return { ok: r.ok, detail: 'CC10 pan centre on ch1' };
      }));
      cases.push(await measure('send a batch', 'write/midi', 'posted', async () => {
        const r = await live.sendMessages([[0x90, 60, 1], [0x80, 60, 0]], { channel: 16 });
        return { ok: r.ok, detail: `${r.sent} messages in one round trip` };
      }));
    }
  }
  } else {
    skipped.push(...WRITE_CASE_NAMES);
  }

  // ---- T1 (CakeScript) availability ----
  cases.push(await measure('CakeScript transport', 'transport/T1', 'independent', async () => {
    const s = await call('status');
    const found = !!(s.assistant && s.assistant.found);
    return {
      ok: found,
      detail: found ? `${s.assistant.cls} present` : 'no XCD*/LLM* window (expected on 2026.10)',
    };
  }));

  // ---- summarise ----
  const byGroup = {};
  for (const c of cases) {
    const g = (byGroup[c.group] ||= { pass: 0, fail: 0, error: 0, totalMs: 0 });
    g[c.status === 'pass' ? 'pass' : c.status === 'error' ? 'error' : 'fail']++;
    g.totalMs += c.ms;
  }
  const passed = cases.filter((c) => c.status === 'pass').length;
  return {
    when: new Date().toISOString(),
    document: { open: docIdx.projectOpen, project: docIdx.project || null },
    summary: {
      total: cases.length,
      passed,
      failed: cases.filter((c) => c.status === 'fail').length,
      errors: cases.filter((c) => c.status === 'error').length,
      totalMs: cases.reduce((a, c) => a + c.ms, 0),
    },
    // A sweep that omitted stages must say so, or a short run reads as a complete
    // one. Same principle as cw_verify_commands' notProbed.
    skipped,
    partial: skipped.length > 0,
    /*
     * `skipped` holds stages omitted for TWO different reasons, and an earlier
     * version of this note blamed them all on the plugin inventory. That was wrong
     * in a way that cost the reader: seven of the nine are the write cases, and
     * following the note's advice (`full: true`) pulls in ~55s of writes on top of
     * the plugin scan, so a client acting on it gets a 70s+ sweep it was not warned
     * about. Grouped by cause, with the real prices.
     */
    partialNote: skipped.length
      ? `Skipped ${skipped.length} stage(s), for two different reasons. `
        + `Plugin inventory (adds 10-20s): `
        + `${skipped.filter((s) => /plugin/i.test(s)).join(', ') || 'none'}. `
        + `Write cases — each posts a command then waits for the UI, ~55s for the set: `
        + `${skipped.filter((s) => !/plugin/i.test(s)).join(', ') || 'none'}. `
        + 'full: true runs BOTH groups and takes 70s+, which is past a typical client timeout — '
        + 'prefer includePluginScan: true or includeWrites: true to add just one.'
      : undefined,
    byTransport: byGroup,
    cases,
    legend: {
      pass: 'the case did what it claims',
      fail: 'answered, but the operation did not take effect',
      error: 'threw — the transport or the target is unavailable',
      confirmation: {
        independent: 'checked with a signal other than the one acted on (strongest)',
        roundtrip: 're-read the same element after the action',
        posted: 'the call was accepted and nothing errored (weakest)',
      },
    },
    reading:
      'Fails in write/… are the honest boundary of this adapter: SONAR\'s accessibility layer '
      + 'reports track state but does not accept changes, and its transport is drawn rather than '
      + 'exposed. Fails in transport/T1 are the build lacking the CakeScript IPC window.',
  };
}

/**
 * Survey every track control's write path.
 *
 * This is the measurement behind the claim "reading works, writing does not".
 * For each control it records the value, the advertised actions, and whether an
 * attempted write changed the value. It reads twice with a delay so a slow
 * repaint has a chance to land, and it never writes anything destructive: pan,
 * volume and the toggle flags are all safe to poke, and the result records
 * whether the poke took.
 *
 * The caller supplies the accessibility side, because only a computer-use
 * runtime can see these elements — this server cannot. Pass an object with
 *   { elements(): Promise<[{index, kind, title, value, actions}]>,
 *     setValue(index, v), press(index) }
 * or omit it and the function returns the plan plus the known expectations.
 */
export async function surveyTrackWrites(bridge) {
  const known = {
    measuredOn: '32.10.0.021',
    finding: 'Every control advertises AXSetValue / AXToggle / AXPress and the runtime accepts the '
      + 'call, but the value does not change. SONAR\'s accessibility layer reports state for screen '
      + 'readers; it does not accept it.',
    verified: [
      { control: '音量 on Track 17', attempted: 'AXSetValue "50" against "101"', result: 'still "101"' },
      { control: '录制 on Track 17', attempted: 'AXToggle and AXPress', result: 'still "关闭"' },
      { control: '声像 on Track 1', attempted: 'AXSetValue "50% 右" against "0% 中"', result: 'still "0% 中"' },
      { control: '独奏 on Track 2', attempted: 'AXPress', result: 'still "关闭"; screenshot unchanged' },
    ],
    writableByOtherMeans: {
      'track volume / pan / mute / solo / arm': 'not writable through this adapter',
      'what IS writable': [
        'MIDI note and CC data (cw_midi_*) — reaches the engine, needs an armed destination',
        'project structure (cw_add_track) — insert commands are dispatched',
        'standard MFC dialogs (AXSetValue works there — verified on the Open dialog\'s filename field)',
      ],
    },
    whyTheValueIsNotJustStale:
      'A screenshot taken after the AXPress showed the solo button unchanged, so the failure is real '
      + 'and not a caching artefact of the accessibility value.',
  };

  if (!bridge || typeof bridge.elements !== 'function') {
    return { plan: 'pass { elements, setValue, press } to run the survey live', expectations: known };
  }

  const els = await bridge.elements();
  const trackNums = [...new Set(
    els.filter((e) => / on Track \d+$/.test(e.title || ''))
      .map((e) => Number(e.title.match(/Track (\d+)$/)[1]))
  )];
  const results = [];

  const readVal = async (title) => {
    const list = await bridge.elements();
    return list.find((e) => e.title === title)?.value ?? null;
  };

  for (const n of trackNums) {
    for (const label of ['声像', '音量', '力度+']) {
      const title = `${label} on Track ${n}`;
      const el = els.find((e) => e.title === title);
      if (!el) continue;
      const before = el.value;
      const candidate = label === '声像' ? '40% 右' : String(Number(before) + 11 || 50);
      let accepted = false;
      try { await bridge.setValue(el.index, candidate); accepted = true; } catch (_) { /* rejected */ }
      await new Promise((r) => setTimeout(r, 800));
      const after = await readVal(title);
      results.push({
        control: title, kind: 'slider', advertised: el.actions,
        before, attempted: candidate, acceptedButUnchanged: accepted && after === before,
        after, changed: after !== before,
      });
    }
    for (const label of ['手动静音', '独奏']) {
      const title = `${label} on Track ${n}`;
      const el = els.find((e) => e.title === title);
      if (!el) continue;
      const before = el.value;
      let accepted = false;
      try { await bridge.press(el.index); accepted = true; } catch (_) { /* rejected */ }
      await new Promise((r) => setTimeout(r, 800));
      const after = await readVal(title);
      results.push({
        control: title, kind: 'button', advertised: el.actions,
        before, attempted: 'AXPress', acceptedButUnchanged: accepted && after === before,
        after, changed: after !== before,
      });
    }
  }

  const changed = results.filter((r) => r.changed);
  return {
    tracksSurveyed: trackNums,
    controlsTested: results.length,
    changed,
    allUnchanged: changed.length === 0,
    results,
    expectations: known,
  };
}
/**
 * A quick per-operation latency profile, useful when sizing a workflow.
 *
 * `includePluginReads` defaults to false because that stage reads SONAR's plugin
 * inventory (946 registry entries on this machine) and pushed the whole call past
 * 20s — long enough that a bare `cw_latency` looked like a hung tool rather than a
 * slow one. The cheap stages answer in a few seconds and are what sizing a
 * workflow actually needs; the plugin stage is opt-in and its absence is stated.
 *
 * `budgetMs` bounds the whole profile for the same reason. Profiling showed the
 * real cost is `menu: post a command` at ~4s per run — runCommand waits for the UI
 * to settle, which is inherent to it — so even three stages overshoot a client's
 * patience. Rather than report a truncated set silently, stages that did not run
 * are named in `skipped`, on the same reasoning as cw_verify_commands' notProbed.
 */
export async function latencyProfile({ includePluginReads = false, budgetMs = 12_000 } = {}) {
  const samples = [];
  const skipped = [];
  const started = now();
  const time = async (name, fn, runs = 5) => {
    if (now() - started > budgetMs) {
      skipped.push(name);
      return;
    }
    const times = [];
    let failed = 0;
    let firstError = null;
    for (let i = 0; i < runs; i++) {
      const t0 = now();
      try { await fn(); } catch (e) {
        // A failed call still took time, but it is not a measurement of the
        // operation. Record the failure instead of letting `ran` imply success.
        failed++;
        if (!firstError) firstError = e && e.message ? e.message : String(e);
      }
      times.push(now() - t0);
      // A stage that is slow per run must not push the whole profile over budget
      // on its own; one sample still tells the caller the order of magnitude.
      if (now() - started > budgetMs) break;
    }
    times.sort((a, b) => a - b);
    samples.push({
      name,
      runs,
      ran: times.length,
      failed,
      error: firstError || undefined,
      minMs: times[0],
      medianMs: times[Math.floor(times.length / 2)],
      maxMs: times[times.length - 1],
    });
  };

  /*
   * Ordered cheapest first, deliberately.
   *
   * The budget is consumed in order, so whichever stage runs last is the one that
   * gets dropped. Listing them in the order they were thought of put the 22ms MIDI
   * measurement last, behind two bridge calls and a 4s menu post — so a tight
   * budget threw away the most useful number and kept the expensive ones. The
   * caller sizing a workflow wants all four; if one must go, it should be the one
   * that costs seconds to obtain.
   */
  await time('midi: send one message', async () => {
    const st = await live.liveStatus();
    if (!st.selected) throw new Error('no port');
    return live.sendCC(1, 10, 64);
  }, 3);
  await time('bridge: status', () => call('status'), 2);
  await time('bridge: menu tree', async () => {
    const { menuTree } = await import('./menu.js');
    return menuTree({ refresh: true });
  }, 2);
  await time('menu: post a command', () => runCommand(0x801F), 2);
  // Only measured when asked for: zero runs would push a sample with undefined
  // timings, which reads like a measurement that was taken.
  if (includePluginReads) {
    await time('plugins: inventory (warm)', async () => pluginSummary(), 3);
  } else {
    skipped.push('plugins: inventory');
  }

  // A stage that ran fewer times than asked is reported too, so a median taken
  // from one sample is not mistaken for one taken from five.
  const partialSamples = samples.filter((s) => s.ran < s.runs).map((s) => s.name);

  return {
    when: new Date().toISOString(),
    samples,
    skipped,
    partial: skipped.length > 0 || partialSamples.length > 0,
    partialSamples,
    elapsedMs: now() - started,
    partialNote: (skipped.length || partialSamples.length)
      ? `Budget ${budgetMs}ms. Skipped: ${skipped.join(', ') || 'none'}. `
        + `Sampled fewer times than asked: ${partialSamples.join(', ') || 'none'}. `
        + 'Measured: a single `menu: post a command` run takes ~11s here, not the ~4s an earlier '
        + 'version of this note claimed, because it posts and then waits for the UI to settle. '
        + 'Raise budgetMs to about 30000 for a full sample set.'
      : undefined,
    note: 'The bridge keeps a PowerShell process alive, so per-call cost is one JSON round trip '
      + 'rather than a process start. The first call in a session is much slower than the rest.',
  };
}
