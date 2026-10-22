// lib/menu.js — read SONAR's own command index and drive it via WM_COMMAND.
//
// Two independent sources of command ids are available:
//
//   1. The live Win32 menu bar. `GetMenuItemID` on the running process gives
//      ids that PostMessage(hwnd, WM_COMMAND, id, 0) executes reliably, on any
//      SONAR build. This is the transport `cw_run_command` uses.
//
//   2. SONAR's command-palette index, a SQLite database at
//      %APPDATA%\Cakewalk\Sonar\cwsearch.dat. It lists every command with a
//      human label, the menu path it lives under (`处理(P)->运行 CakeScript 程序`),
//      and a CMD_ID.
//
// Caveats learned the hard way against 32.10.0.021:
//   * A CMD_ID from the index is NOT a WM_COMMAND id. Sending it is silently
//     dropped. Only ids read from the live menu are safe to post.
//   * A build may register a command (it appears in both the index and the menu
//     resource) yet ship no handler. Resolving an id therefore only proves the
//     id exists, not that the command does anything. `runCommand` reports what
//     happened on the window list so the caller can tell the two apart.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { call } from '../bridge/agent.js';
import { EDIT_COMMANDS } from './edit.js';
import { PROJECT_COMMANDS } from './project.js';
import { MARKER_COMMANDS, ARRANGER_COMMANDS } from './navigate.js';

const require = createRequire(import.meta.url);

// --- command index (cwsearch.dat) -------------------------------------------

const INDEX_CANDIDATES = [
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cakewalk', 'Sonar', 'cwsearch.dat'),
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Cakewalk', 'SONAR', 'cwsearch.dat'),
];

export function commandIndexPath() {
  for (const p of INDEX_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

let indexCache = null;

/**
 * Load SONAR's command-palette index. Returns an array of
 * { name, description, category, action, cmdId, actionId }.
 * Uses node:sqlite when available; returns null when it is not, since the
 * index is a convenience, not a requirement.
 */
export function loadCommandIndex() {
  if (indexCache !== null) return indexCache;
  const path = commandIndexPath();
  if (!path) { indexCache = []; return indexCache; }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_) {
    const e = new Error('The command index needs node:sqlite (Node 22.5+). Use source="live" '
      + 'on older Node versions, or use the bundled runtime.');
    e.code = 'COMMAND_INDEX_UNSUPPORTED';
    throw e;
  }
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`
      SELECT i.NAME        AS name,
             i.DESCRIPTION AS description,
             i.CMD_ID      AS cmdId,
             i.ACTION_ID   AS actionId,
             i.ACTION_TYPE_ID AS actionTypeId,
             c.NAME        AS category
      FROM ITEM i
      LEFT JOIN CATEGORY c ON c.CATEGORY_ID = i.CATEGORY_ID
    `).all();
    db.close();
    indexCache = rows.map((r) => ({
      name: r.name,
      description: r.description,
      category: r.category,
      cmdId: r.cmdId,
      actionId: r.actionId,
      actionTypeId: r.actionTypeId,
    }));
    return indexCache;
  } catch (_) {
    indexCache = [];
    return indexCache;
  }
}

/** Case-insensitive substring search over the command index. */
export function searchCommands(query, limit = 40) {
  const idx = loadCommandIndex();
  const q = String(query || '').toLowerCase();
  if (!q) return idx.slice(0, limit);
  const out = [];
  for (const row of idx) {
    const hay = `${row.name || ''} ${row.description || ''}`.toLowerCase();
    if (hay.includes(q)) {
      out.push(row);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// --- live menu tree ---------------------------------------------------------

let menuCache = null;
let menuAt = 0;
// Short TTL rather than "forever". A long-lived server that probed the menu while
// SONAR was starting cached an empty tree and stayed blind after the menu existed.
const MENU_TTL_MS = 3000;

/** Dump the real Win32 menu bar of the running SONAR (flattened). */
export async function menuTree({ refresh = false } = {}) {
  if (menuCache && !refresh && Date.now() - menuAt < MENU_TTL_MS) return menuCache;
  const r = await call('menu');
  let tree = r && r.menu ? r.menu : [];
  // PowerShell's ConvertTo-Json collapses a one-element array into an object,
  // and an empty one into null. Normalise both back to an array.
  if (!Array.isArray(tree)) tree = tree ? [tree] : [];
  if (tree.length) { menuCache = tree; menuAt = Date.now(); }
  return tree;
}

/** Flatten the nested menu tree into [{ path, label, cmdId }]. */
export function flattenMenu(tree, prefix = '') {
  const out = [];
  for (const node of Array.isArray(tree) ? tree : []) {
    const label = (node.label || '').replace(/\(&?[A-Za-z]\)/g, '').replace(/&/g, '').trim();
    const path = prefix ? `${prefix} > ${label}` : label;
    if (node.cmdId !== null && node.cmdId !== undefined) {
      out.push({ path, label, cmdId: node.cmdId, cmdHex: node.cmdHex });
    }
    if (node.children) out.push(...flattenMenu(node.children, path));
  }
  return out;
}

/**
 * Every command the live menu exposes, flattened. Use this to discover ids that
 * are safe to post — unlike index CMD_IDs.
 */
export async function liveCommands({ refresh = false } = {}) {
  const tree = await menuTree({ refresh });
  return flattenMenu(tree);
}

/** Find a live menu command by substring match on its full path. */
export async function findLiveCommand(pattern, { refresh = false } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
  const all = await liveCommands({ refresh });
  return all.filter((c) => re.test(c.path));
}

// --- dispatch ---------------------------------------------------------------

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v === null || v === undefined ? [] : [v];
}

// Commands that discard work. They need an explicit acknowledgement, and the
// check lives HERE rather than in one tool: the audit found the same close/revert
// reachable through cw_run_command_classified and cw_verify_commands, which call
// this function directly.
const DESTRUCTIVE = {
  0xE102: 'close',
  0x853D: 'revert',
  0xE141: 'quit',
};

/**
 * Trigger a menu command by numeric id. Returns the bridge's report plus the
 * window lists before and after, so the caller can see whether anything
 * actually happened: a command this build registered without a handler posts
 * fine and changes nothing.
 */
export function assertCommandAllowed(cmdId, confirm) {
  const raw = Number(cmdId);
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
    const e = new Error(`command id ${String(cmdId)} is not a finite integer`);
    e.code = 'BAD_COMMAND_ID';
    throw e;
  }
  // WM_COMMAND takes the command id from LOWORD(wParam), so 0xE102 + 0x10000 is
  // the same command to Windows. Normalise before the gate or an offset id walks
  // straight past the acknowledgement.
  const id = raw & 0xffff;

  // Seeded by the hand-written destructive-only map; the metadata catalogs are
  // walked lazily below so this module never builds a global at load time (which
  // would run before the imported catalogs are initialised — a TDZ cycle).
  let need = DESTRUCTIVE[id];

  if (!need) {
    // Only these catalogs, in this order, may raise an unlisted command to the
    // acknowledgement gate. Everything else is left exactly as it was.
    const catalogs = [EDIT_COMMANDS, PROJECT_COMMANDS, MARKER_COMMANDS, ARRANGER_COMMANDS];
    for (const catalog of catalogs) {
      for (const key of Object.keys(catalog)) {
        const entry = catalog[key];
        if (!entry || (Number(entry.cmdId) & 0xffff) !== id) continue;
        const risky = entry.risk === 'destructive'
          || entry.requiresAcknowledgement === true
          || entry.destructive === true
          || (catalog === PROJECT_COMMANDS && entry.risk === 'high');
        if (risky) need = key;
        break;
      }
      if (need) break;
    }
  }

  if (need && confirm !== need) {
    const e = new Error(
      `command 0x${id.toString(16).toUpperCase()} is destructive (${need}). `
      + `Pass confirm: '${need}' to post it, and save first if the work matters.`
    );
    e.code = 'NEEDS_CONFIRMATION';
    throw e;
  }
  return id;
}

export async function runCommand(cmdId, { keepOverlays = false, confirm } = {}) {
  const id = assertCommandAllowed(cmdId, confirm);

  const before = await call('status');
  const posted = await call('runmenu', { cmdId: id, keepOverlays });
  // The bridge reports transport failure as {error} rather than throwing. That
  // used to be returned as an ordinary result, so cw_project reported ok:true for
  // a save that never ran.
  if (posted && posted.error) {
    const e = new Error(posted.error);
    e.code = posted.error === 'sonar not running' ? 'SONAR_NOT_RUNNING' : 'COMMAND_FAILED';
    throw e;
  }
  await new Promise((r) => setTimeout(r, 1200));
  const after = await call('status');
  const beforeWins = new Set(asArray(before.allWindows).map((w) => `${w.cls}|${w.title}`));
  const newWindows = asArray(after.allWindows).filter((w) => !beforeWins.has(`${w.cls}|${w.title}`));
  return {
    ...posted,
    effect: newWindows.length ? 'window-change' : 'none-observed',
    // The effect name is about TOP-LEVEL WINDOWS, not about the command. Playback,
    // view toggles and drawn edits change the screen without adding a window, so
    // "none-observed" must not be read as "did nothing".
    effectMeans: 'top-level windows only. A command that changes a drawn surface '
      + '(playback, a view toggle, a redraw) produces none-observed while working.',
    newWindows,
  };
}

/**
 * Clear transient overlays — menus, tooltips, stray popups — without touching
 * dialogs.
 *
 * `closeDialogs` defaults to false: a #32770 dialog may be a prompt holding the
 * user's unsaved work, so dismissing one has to be asked for twice — once with
 * `closeDialogs: true` AND once with `confirm: 'closeDialogs'`, checked here
 * before the bridge is called at all, so nothing is dismissed on a failed gate.
 */
export async function closeOverlays({ closeDialogs = false, confirm } = {}) {
  if (closeDialogs && confirm !== 'closeDialogs') {
    const e = new Error(
      'closeOverlays would dismiss #32770 dialogs. Pass '
      + `confirm: 'closeDialogs' to do that, and read the prompt first — `
      + 'a dialog showing after an edit is usually asking whether to save.'
    );
    e.code = 'NEEDS_CONFIRMATION';
    e.confirm = 'closeDialogs';
    throw e;
  }
  return call('overlays', closeDialogs
    ? { close: true, closeDialogs: true }
    : { close: true });
}

/** List modal overlays currently blocking menu commands. */
export async function listOverlays() {
  return call('overlays', {});
}
