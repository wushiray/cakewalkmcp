// lib/run.js — high-level: invoke a CakeScript template and return its result.
//
// Every template flows through the T1 (AI-Assistant) transport. When that
// transport is missing — SONAR 2026.10 removed it — we do not fail with a raw
// timeout; we ask dispatch.js for the blocking reason so the caller is told
// which transport *is* available and what to do instead.

import { call } from '../bridge/agent.js';
import { templates } from './cake_templates.js';
import { findSonar, isSonarRunning } from './sonar.js';
import { cakeScriptBlocker } from './dispatch.js';

let assistantReady = null;

export async function ensureAssistant() {
  if (assistantReady) return assistantReady;
  const blocker = await cakeScriptBlocker();
  if (blocker) throw blocker;
  // The bridge has no init/toolcall operations: the cake_templates payloads were
  // designed for the old write_cakescript/run_cakescript IPC, which this bridge
  // never implemented. `call('init')` returned {error:'unknown op'} and was then
  // treated as success, so the whole T1 claim was unverifiable. Until that IPC is
  // implemented and tested against a host that exposes the Assistant, say so.
  const e = new Error(
    'CakeScript (T1) is detected on this host, but this adapter does not implement its IPC. '
    + 'The bridge has no init/toolcall operation, so no template can be dispatched. '
    + 'Use the menu commands (T2), the MIDI transport (T4) or the editing dialogs instead.'
  );
  e.code = 'T1_CHAIN_UNIMPLEMENTED';
  throw e;
}

export async function runTemplate(name, args = []) {
  const tpl = templates[name];
  if (!tpl) throw new Error(`unknown template: ${name}`);
  await ensureAssistant();
  const payload = typeof tpl === 'function' ? tpl(...args) : tpl;
  const r = await call('toolcall', JSON.stringify(payload));
  if (!r.ok) {
    const e = new Error(`SONAR tool call returned 0 (rc=${r.result}). Is the AI Assistant still open?`);
    e.code = 'TOOL_CALL_FAILED';
    e.detail = r;
    throw e;
  }
  return r;
}

export function hostStatus() {
  return {
    sonar_path: findSonar(),
    sonar_running: isSonarRunning(),
  };
}
