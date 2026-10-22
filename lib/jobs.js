// lib/jobs.js — background handles for slow operations.
//
// WHY THIS EXISTS
//
// Several operations in this project are slow for measured reasons, not
// incidental ones: one track insert takes ~19s (a menu post plus a settle
// wait), a full command survey is ~15s per probe, a plugin inventory scan is
// 10s+, and a CAL run needs a human or a computer-use runtime to dismiss a
// dialog. An MCP tool call that simply blocks for a minute is unusable — the
// client times out and the caller cannot tell "still working" from "hung".
//
// So a slow tool can hand back a job id immediately and the caller polls.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// No cancellation. A menu command already posted to SONAR cannot be recalled,
// and pretending otherwise would be a lie in the API surface. `cancel` marks a
// job abandoned so its result is discarded; it does not stop the underlying
// work, and the docs say so.
//
// No persistence. Jobs live in one process for one session. A restarted adapter
// has no jobs, which is honest — the work those jobs referred to either
// finished inside SONAR or did not.

import { randomBytes } from 'node:crypto';

/** How a job ended. `abandoned` is a caller's choice, not a failure. */
export const JOB_STATES = Object.freeze({
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
});

const MAX_JOBS = 200;

/** jobId -> record. Insertion order is the age order, which is what eviction uses. */
const jobs = new Map();

function newId(prefix) {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/**
 * Start a job.
 *
 * `run` is called immediately and its promise tracked. It must not throw
 * synchronously — an async function never does — and any rejection is recorded
 * on the job rather than surfacing as an unhandled rejection, because by then
 * the caller has already been handed an id and is polling.
 */
export function startJob(name, run, { detail = {} } = {}) {
  const id = newId(name.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'job');
  const record = {
    id,
    name,
    state: JOB_STATES.RUNNING,
    startedAt: Date.now(),
    finishedAt: null,
    // Steps the caller can watch, appended by the worker via `progress`.
    progress: [],
    detail,
    result: null,
    error: null,
  };
  jobs.set(id, record);

  // Evict the oldest finished jobs once there are too many, so a long session
  // cannot grow without bound. Running jobs are never evicted.
  if (jobs.size > MAX_JOBS) {
    for (const [key, j] of jobs) {
      if (j.state !== JOB_STATES.RUNNING) { jobs.delete(key); }
      if (jobs.size <= MAX_JOBS) break;
    }
  }

  const progress = (message) => {
    // Cap the trail: a job that runs for thousands of steps should not turn
    // into a memory leak, and the last 50 are the ones anyone reads.
    record.progress.push({ at: Date.now(), message: String(message).slice(0, 300) });
    if (record.progress.length > 50) record.progress.shift();
  };

  Promise.resolve()
    .then(() => run(progress))
    .then((result) => {
      if (record.state === JOB_STATES.ABANDONED) return;
      record.state = JOB_STATES.DONE;
      record.result = result ?? null;
      record.finishedAt = Date.now();
    })
    .catch((err) => {
      if (record.state === JOB_STATES.ABANDONED) return;
      record.state = JOB_STATES.FAILED;
      // Keep the code and the message: callers branch on the code, humans read
      // the message, and losing either makes a background failure undebuggable.
      record.error = { message: err && err.message ? err.message : String(err), code: err && err.code };
      record.finishedAt = Date.now();
    });

  return record;
}

/** One job's current state, or null. */
export function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return {
    ...j,
    elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt,
    // A polling caller mostly wants this: is it worth asking again.
    running: j.state === JOB_STATES.RUNNING,
  };
}

/** Every job, newest first, with a summary rather than full payloads. */
export function listJobs({ limit = 20 } = {}) {
  return [...jobs.values()]
    .reverse()
    .slice(0, limit)
    .map((j) => ({
      id: j.id,
      name: j.name,
      state: j.state,
      startedAt: j.startedAt,
      elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt,
      steps: j.progress.length,
      error: j.error ? j.error.message : null,
    }));
}

/**
 * Mark a job abandoned so its result is discarded.
 *
 * Documented plainly because the name overpromises: this does NOT stop work
 * already handed to SONAR. It stops this module from reporting it.
 */
export function abandonJob(id) {
  const j = jobs.get(id);
  if (!j) return { ok: false, error: `no such job: ${id}` };
  if (j.state !== JOB_STATES.RUNNING) {
    return { ok: false, error: `job ${id} already ${j.state}`, state: j.state };
  }
  j.state = JOB_STATES.ABANDONED;
  j.finishedAt = Date.now();
  return {
    ok: true,
    id,
    state: j.state,
    note: 'The underlying operation was NOT stopped — a posted menu command cannot be '
      + 'recalled. Its result will be discarded when it finishes.',
  };
}

/** Forget finished jobs. Running ones stay, or the caller loses track of them. */
export function clearJobs() {
  let removed = 0;
  for (const [key, j] of jobs) {
    if (j.state !== JOB_STATES.RUNNING) { jobs.delete(key); removed++; }
  }
  return { ok: true, removed, remaining: jobs.size };
}

export function jobHelp() {
  return {
    why: 'Some operations here are slow for measured reasons: one track insert is ~19s '
      + '(menu post plus settle), a command survey is ~15s per probe, a plugin scan is 10s+. '
      + 'Returning a job id lets a caller poll instead of timing out against a blocked call.',
    states: Object.values(JOB_STATES),
    usage: [
      'A slow tool returns { job: "<id>" } instead of blocking.',
      'Poll with cw_job { id } until state is done or failed.',
      'cw_jobs lists recent jobs without their payloads.',
    ],
    cannotCancel: 'abandonJob marks a job abandoned so its result is discarded; it does NOT '
      + 'stop work already posted to SONAR. A menu command that has been sent cannot be recalled.',
    lifetime: 'Jobs live in the adapter process for one session. Restarting the adapter loses '
      + 'them — the work either finished inside SONAR or it did not.',
  };
}
