// test/jobs.test.mjs — the async job handle.
//
// The interesting properties are all about what a POLLING caller can learn and
// what it must not be misled about:
//   - a job that throws is recorded as failed, not left running forever
//   - a failure keeps both its code and its message
//   - abandoning a job does not claim to have stopped the work
//   - a finished job reports its elapsed time, not a growing one
//
// Timing is kept out of the assertions where possible: a test that depends on
// "the work takes 20ms" is a test that fails on a loaded machine.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startJob, getJob, listJobs, abandonJob, clearJobs, jobHelp, JOB_STATES,
} from '../lib/jobs.js';

// A promise the test can settle by hand, so nothing races.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Let the internal .then chain run.
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => { clearJobs(); });

describe('a job that succeeds', () => {
  test('starts as running and becomes done with its result', async () => {
    const d = deferred();
    const job = startJob('demo', () => d.promise);

    assert.equal(job.state, JOB_STATES.RUNNING);
    assert.equal(getJob(job.id).running, true);

    d.resolve({ answer: 42 });
    await settle();

    const after = getJob(job.id);
    assert.equal(after.state, JOB_STATES.DONE);
    assert.deepEqual(after.result, { answer: 42 });
    assert.equal(after.running, false);
  });

  test('elapsed time stops growing once finished', async () => {
    const d = deferred();
    const job = startJob('demo', () => d.promise);
    d.resolve('ok');
    await settle();

    const a = getJob(job.id).elapsedMs;
    await new Promise((r) => setTimeout(r, 15));
    const b = getJob(job.id).elapsedMs;
    assert.equal(a, b, 'a finished job must report a frozen elapsed time');
  });
});

describe('a job that fails', () => {
  test('records failed with both the message and the code', async () => {
    const job = startJob('demo', async () => {
      const e = new Error('SONAR said no');
      e.code = 'NO_EFFECT';
      throw e;
    });
    await settle();

    const after = getJob(job.id);
    assert.equal(after.state, JOB_STATES.FAILED);
    // Losing the code would make a background failure impossible to branch on.
    assert.equal(after.error.code, 'NO_EFFECT');
    assert.equal(after.error.message, 'SONAR said no');
    assert.equal(after.running, false);
  });

  test('a thrown non-Error is still recorded', async () => {
    const job = startJob('demo', async () => { throw 'just a string'; });
    await settle();
    const after = getJob(job.id);
    assert.equal(after.state, JOB_STATES.FAILED);
    assert.equal(after.error.message, 'just a string');
  });

  test('the rejection does not escape as an unhandled rejection', async () => {
    // The caller already holds an id by the time this rejects, so nothing is
    // awaiting it. If the module let it propagate the process would die.
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);

    startJob('demo', async () => { throw new Error('boom'); });
    await new Promise((r) => setTimeout(r, 30));

    process.removeListener('unhandledRejection', onUnhandled);
    assert.equal(unhandled, null, 'a job rejection must be captured, not left unhandled');
  });
});

describe('progress', () => {
  test('steps are recorded in order', async () => {
    const job = startJob('demo', async (progress) => {
      progress('first');
      progress('second');
      return 'done';
    });
    await settle();

    const after = getJob(job.id);
    assert.deepEqual(after.progress.map((p) => p.message), ['first', 'second']);
  });

  test('the trail is bounded so a long job cannot grow without limit', async () => {
    const job = startJob('demo', async (progress) => {
      for (let i = 0; i < 500; i++) progress(`step ${i}`);
      return 'done';
    });
    await settle();

    const after = getJob(job.id);
    assert.ok(after.progress.length <= 50, `expected <= 50 steps, got ${after.progress.length}`);
    // And it keeps the NEWEST ones, which is what anyone reading it wants.
    assert.match(after.progress.at(-1).message, /step 499/);
  });
});

describe('abandoning', () => {
  test('marks the job abandoned and says the work was not stopped', async () => {
    const d = deferred();
    const job = startJob('demo', () => d.promise);

    const r = abandonJob(job.id);
    assert.equal(r.ok, true);
    assert.equal(getJob(job.id).state, JOB_STATES.ABANDONED);
    // The wording is the point: this must not imply cancellation.
    assert.match(r.note, /NOT stopped/);
  });

  test('a result arriving after abandonment is discarded', async () => {
    const d = deferred();
    const job = startJob('demo', () => d.promise);
    abandonJob(job.id);

    d.resolve({ should: 'be ignored' });
    await settle();

    const after = getJob(job.id);
    assert.equal(after.state, JOB_STATES.ABANDONED, 'a late result must not resurrect the job');
    assert.equal(after.result, null);
  });

  test('a failure arriving after abandonment is discarded too', async () => {
    const d = deferred();
    const job = startJob('demo', () => d.promise);
    abandonJob(job.id);
    d.reject(new Error('too late'));
    await settle();
    assert.equal(getJob(job.id).state, JOB_STATES.ABANDONED);
  });

  test('abandoning a finished job is refused with its state', async () => {
    const job = startJob('demo', async () => 'done');
    await settle();
    const r = abandonJob(job.id);
    assert.equal(r.ok, false);
    assert.equal(r.state, JOB_STATES.DONE);
  });

  test('abandoning an unknown id is refused', () => {
    const r = abandonJob('nope-1234');
    assert.equal(r.ok, false);
    assert.match(r.error, /no such job/);
  });
});

describe('listing and clearing', () => {
  test('lists newest first with a summary, not the payload', async () => {
    const a = startJob('first', async () => ({ big: 'x'.repeat(1000) }));
    await settle();
    const b = startJob('second', async () => 'ok');
    await settle();

    const list = listJobs();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, b.id, 'newest first');
    assert.equal(list[1].id, a.id);
    assert.equal(list[0].state, JOB_STATES.DONE);
    // A list must not carry results, or a hundred jobs is a hundred payloads.
    assert.equal(list[0].result, undefined);
    assert.equal(list[0].steps, 0);
  });

  test('an unknown id reads as null rather than throwing', () => {
    assert.equal(getJob('does-not-exist'), null);
  });

  test('clearing removes finished jobs but keeps running ones', async () => {
    const running = startJob('slow', () => new Promise(() => {}));
    const done = startJob('quick', async () => 'ok');
    await settle();

    const r = clearJobs();
    assert.equal(r.ok, true);
    assert.equal(r.removed, 1, 'only the finished job should go');
    assert.ok(getJob(running.id), 'a running job must survive a clear');
    assert.equal(getJob(done.id), null);
  });
});

describe('the help text', () => {
  test('states plainly that a job cannot be cancelled', () => {
    const h = jobHelp();
    // The API has no cancel; saying so up front is the honest version.
    assert.match(h.cannotCancel, /does NOT stop/);
    assert.ok(h.why.length > 0);
  });
});
