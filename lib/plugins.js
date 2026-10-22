// lib/plugins.js — find the plugins SONAR has registered.
//
// Three sources, in order of usefulness:
//
//   1. The registry inventory at
//      HKCU\SOFTWARE\Cakewalk Music Software\Cakewalk\Cakewalk VST X64\Inventory
//      This is SONAR's own scan result, so it is authoritative: 946 entries on
//      this machine, 653 of them named. Each named entry is keyed
//        "<dll path>*<index> <plugin name>"
//      and holds `clsidPlug` (a GUID) plus display metadata. It covers effects
//      AND instruments — the four bundled Studio Instruments (SI-Bass Guitar,
//      SI-Drum Kit, SI-Electric Piano, SI-String Section) are in here alongside
//      every VST3.
//
//   2. The plugin menu layout at
//      %APPDATA%\Cakewalk\Sonar\Plug-in Menu Layouts\defaultCat.pgl.tmp
//      XML, organised into the same folders SONAR shows in its plugin menus
//      (Analyzer, Delay, Dynamics, EQ, Reverb, ...). It only contains effects —
//      instruments are not in the layout — but it gives the *category* a plugin
//      appears under, which the registry does not.
//
//   3. The filesystem. Used only to confirm a registered DLL still exists, and
//      to find instrument DLLs that SONAR may not have registered. A registry
//      entry whose file is gone is exactly the failure that produces SONAR's
//      "One of the files this plug-in needs cannot be found" dialog, so this
//      check is worth having.
//
// Reading is a plain filesystem/registry job — no SONAR interaction, so it
// works whether or not SONAR is running, and on any build.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const INVENTORY_KEY = 'HKCU\\SOFTWARE\\Cakewalk Music Software\\Cakewalk\\Cakewalk VST X64\\Inventory';

function appdataDir() {
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appdata, 'Cakewalk', 'Sonar');
}

export function layoutPath() {
  const p = join(appdataDir(), 'Plug-in Menu Layouts', 'defaultCat.pgl.tmp');
  return existsSync(p) ? p : null;
}

// --- registry inventory ------------------------------------------------------

let inventoryCache = null;
let clsidCache = null;

/**
 * Every plugin SONAR has registered, as
 *   { name, file, index, clsid, kind }
 * `kind` is 'instrument' or 'effect', guessed from the name and the file path —
 * the registry itself does not classify them.
 *
 * Two read strategies, because the difference is 10 s vs 44 ms on this machine:
 * the top-level `reg query` returns all 946 subkey NAMES (which carry the path,
 * index and plugin name) without their values; `/s` recurses into every subkey
 * to fetch `clsidPlug`. We take the cheap one by default and fetch CLSIDs only
 * when something actually needs them (see clsidFor).
 */
export function loadInventory({ refresh = false } = {}) {
  if (inventoryCache && !refresh) return inventoryCache;
  let out = [];
  try {
    const raw = execFileSync('reg.exe', ['query', INVENTORY_KEY], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    });
    out = parseInventoryKeyNames(raw);
  } catch (_) {
    out = [];
  }
  inventoryCache = out;
  if (refresh) clsidCache = null;
  return out;
}

/**
 * Parse the top-level `reg query` output: one line per subkey, prefixed with the
 * key path. No values, so no clsidPlug — but the subkey name itself is
 * "<dll path>*<index> <plugin name>" for a named plugin.
 *
 * Returns an ARRAY of named plugins with a `scannedOnly` array hanging off it —
 * the files SONAR scanned but never named. The side-channel is deliberate (two
 * lists from one parse) but it is a trap for callers: an empty result still has
 * the property, so `assert.deepEqual(result, [])` fails on it. loadInventory
 * reads `scannedOnly` without a guard, so it must always be attached.
 */
export function parseInventoryKeyNames(text) {
  const items = [];
  const files = [];
  const marker = '\\Inventory\\';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/^HKEY_/i.test(line)) continue;
    const at = line.indexOf(marker);
    const entry = at >= 0 ? line.slice(at + marker.length) : line;
    const m = entry.match(/^(.*?)\*(\d+)\s+(.+)$/);
    if (m) {
      items.push({ file: m[1], index: Number(m[2]), name: m[3].trim(), clsid: null, named: true });
    } else if (/\.(dll|vst3)$/i.test(entry)) {
      files.push(entry);
    }
  }
  const mapped = items.map((it) => ({ ...it, kind: guessKind(it) }));
  mapped.scannedOnly = files;
  return mapped;
}

/** Fetch one plugin's CLSID on demand, the expensive way. Cached. */
export function clsidFor(plugin) {
  if (plugin.clsid) return plugin.clsid;
  if (!clsidCache) clsidCache = new Map();
  const key = `${plugin.file}*${plugin.index}`;
  if (clsidCache.has(key)) return clsidCache.get(key);
  let clsid = null;
  try {
    const sub = `${INVENTORY_KEY}\\${plugin.file}*${plugin.index} ${plugin.name}`;
    const raw = execFileSync('reg.exe', ['query', sub, '/v', 'clsidPlug'], {
      encoding: 'utf8', timeout: 15000,
    });
    const m = raw.match(/\{([0-9A-Fa-f-]{36})\}/);
    if (m) clsid = `{${m[1].toUpperCase()}}`;
  } catch (_) { /* leave null */ }
  clsidCache.set(key, clsid);
  return clsid;
}

/**
 * Plugins that exist only in the menu layout — no inventory entry, no file on
 * disk that the scan recorded.
 *
 * This is the third and last source, and it is small but not empty: Cakewalk's
 * own DX effects (Compressor/Gate and friends) live here, registered with a
 * category-0 entry in the layout while their DLLs sit in the shared plugin
 * folder. Searching only the inventory reported them as missing, which made the
 * adapter disagree with what SONAR's own plugin browser shows.
 */
export function layoutOnlyPlugins(query, { limit = 50 } = {}) {
  const q = String(query || '').toLowerCase();
  const inv = loadInventory();
  const namedClsids = new Set(inv.filter((p) => p.clsid).map((p) => p.clsid.toUpperCase()));
  // The fast inventory intentionally omits CLSIDs. Use its names as well, so
  // known entries do not become "layout only" just because that field is null.
  const knownNames = new Set(inv.map(p => p.name.toLowerCase()));
  for (const file of inv.scannedOnly || []) {
    const base = String(file).replace(/\\/g, '/').split('/').pop().replace(/\.(dll|vst3)$/i, '');
    knownNames.add(base.toLowerCase());
    knownNames.add(base.replace(/_64$/, '').replace(/64$/, '').trim().toLowerCase());
  }
  const seen = new Set();
  const out = [];
  for (const l of loadLayout()) {
    if (l.clsid && namedClsids.has(l.clsid.toUpperCase())) continue;
    if (knownNames.has(l.name.toLowerCase())) continue;
    const identity = l.clsid ? l.clsid.toUpperCase() : l.name.toLowerCase();
    if (seen.has(identity)) continue;
    if (q && !l.name.toLowerCase().includes(q)) continue;
    seen.add(identity);
    // Category 0 in the layout is the DX class; the others are VST effects.
    out.push({
      name: l.name,
      kind: guessKind({ name: l.name, file: '' }),
      format: l.category === 0 ? 'DX' : 'VST',
      clsid: l.clsid,
      category: l.folder,
      present: null,
      source: 'menu-layout-only',
      note: 'Listed in SONAR\'s plugin menu but not in the VST inventory — these are the DX-era '
        + 'effects shipped with the app.',
    });
    if (out.length >= limit) break;
  }
  return out;
}
/**
 * Plugins SONAR scanned into its inventory but never gave a display name.
 *
 * These are real and loadable, but `findPlugins` misses them because it matches
 * the named entries — which is why "Boost11" and "Compressor/Gate" appear in
 * SONAR's own plugin browser yet came back NOT FOUND from a search. The name is
 * recoverable from the filename, and for the Cakewalk-branded ones from the
 * menu layout (which lists them under category 0 = DX).
 */
export function scannedPlugins(query, { limit = 50 } = {}) {
  const inv = loadInventory();
  const files = inv.scannedOnly || [];
  const q = String(query || '').toLowerCase();
  const layout = loadLayout();

  const out = [];
  for (const file of files) {
    const base = String(file).replace(/\\/g, '/').split('/').pop().replace(/\.(dll|vst3)$/i, '');
    // Cakewalk ships some as "<name>_64" / "StBoos64" style.
    const guess = base.replace(/_64$/, '').replace(/64$/, '').trim();
    if (q && !`${base} ${guess} ${file}`.toLowerCase().includes(q)) continue;
    const named = layout.find((l) => l.name.toLowerCase() === guess.toLowerCase());
    out.push({
      name: named ? named.name : guess,
      kind: guessKind({ name: guess, file }),
      format: /\.vst3$/i.test(file) ? 'VST3' : (/Behringer|BOOST11|compgate|Sonitus/i.test(file) ? 'DX' : 'VST2'),
      clsid: named ? named.clsid : null,
      file: String(file).replace(/\\/g, '/'),
      category: named ? named.folder : undefined,
      present: fileExists(file),
      source: 'inventory-scanned-only',
      note: 'In SONAR\'s scan result without a display name; the name here is derived from the file.',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Parse `reg query /s` output.
 *
 * Shape:
 *   HKEY_CURRENT_USER\...\Inventory\<dll path>*<idx> <name>
 *       clsidPlug    REG_SZ    {GUID}
 *
 * Subkey names contain '/', spaces and Windows paths, and are NOT backslash
 * -prefixed, so the key line ends at the value line following it.
 */
export function parseInventoryRegQuery(text) {
  const items = [];
  const files = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const isKeyLine = /^HKEY_/i.test(line);
    if (isKeyLine) {
      // Strip the fixed prefix, keep whatever remains as the entry name.
      const marker = '\\Inventory\\';
      const at = line.indexOf(marker);
      const entry = at >= 0 ? line.slice(at + marker.length) : line;
      const m = entry.match(/^(.*?)\*(\d+)\s+(.+)$/);
      if (m) {
        current = { file: m[1], index: Number(m[2]), name: m[3].trim(), clsid: null, named: true };
        items.push(current);
      } else {
        // A plain file entry: SONAR scanned the DLL but did not expose it as a
        // named plugin. The bundled Studio Instruments land here — they are on
        // disk and in the inventory, yet absent from the named list, which is
        // worth reporting rather than dropping.
        current = null;
        if (/\.(dll|vst3)$/i.test(entry)) files.push(entry);
      }
      continue;
    }
    if (current && /\bclsidPlug\b/i.test(line)) {
      const m = line.match(/\{([0-9A-Fa-f-]{36})\}/);
      if (m) current.clsid = `{${m[1].toUpperCase()}}`;
    }
  }
  items.scannedOnly = files;
  return items.map((it) => ({ ...it, kind: guessKind(it) }));
}

/**
 * How far plugin insertion could actually be driven, measured on 32.10.0.021.
 *
 * This is the honest boundary, and it is a partial one:
 *
 * REACHABLE
 *   * `查看插件` (0x8A59) opens SONAR's plugin browser as a JUCE panel docked on
 *     the right. Verified: the category tree appeared (Analyzer, BandLab,
 *     Channel Strip, Delay, Distortion, Dynamics, EQ, Filter, Guitar,
 *     Mastering, Modulation, ...).
 *   * Expanding a category lists the plugins in it. Verified on Dynamics:
 *     Archetype Mateus Asato (Neural DSP), BL 1176, Boost11, Clean Limiter,
 *     Compander, Compressor/Gate, Curves Resolve live/mono/stereo, DIGI Comp,
 *     FBK Compressor, Gater.
 *   * Each row shows its format on the right — VST3 / VST2 / BandLab / DX —
 *     and selecting a row makes SONAR report the plugin's details in the status
 *     bar: "Neural DSP, VST3, 64 Bit, In: 2, Out: 2". So the browser reads back
 *     which plugin is under the cursor.
 *
 * NOT REACHABLE
 *   * The act of INSERTING a plugin onto a track. Three attempts on the same
 *     selection — single click, double click, and a drag onto the FX area — all
 *     left the track's FX bin empty. A click only moves the selection.
 *   * The plugin panel has no accessibility elements at all: the window's
 *     element count stays at 144 whether the browser is open or closed, and the
 *     category rows, plugin rows and the 音源架/Fx Audio FX tabs carry no
 *     elements. Everything above was driven by screenshot coordinates.
 *   * The track strips expose no FX-slot element either, so there is nothing to
 *     drop onto by name.
 *
 * What this means: plugin *discovery* is fully automatable and accurate (a
 * search now matches what the browser shows, 12/12 on a spot check across VST3,
 * VST2 and DX). Plugin *insertion* needs a human, or a computer-use runtime
 * doing a drag it can verify visually.
 *
 * The one thing an agent CAN do about it: `cw_add_track` inserts a track with
 * SONAR's default instrument attached, which is enough to hear a MIDI part. For
 * a specific third-party instrument, either insert it by hand, or write the part
 * as a .mid file and let the patch (program change) select a GM sound.
 */
export const PLUGIN_INSERT_RECIPE = {
  measuredOn: '32.10.0.021',
  discovery: {
    works: true,
    browsePlugins: { cmdId: 0x8A59, hex: '0x8A59', name: '查看插件', en: 'View plugins' },
    synthRack: { cmdId: 0x81C4, hex: '0x81C4', name: '视图 > 音源架视图', en: 'Views > Synth Rack',
      observed: 'opens a rack pane inside the Track view — verified visually. The pane shows a slot '
        + 'toolbar (+ / delete / settings / an output selector reading "---无---") but none of it '
        + 'carries an accessibility element.' },
    what: '查看插件 docks a JUCE panel on the right with a category tree; expand a category to list '
      + 'its plugins; each row is tagged VST3 / VST2 / BandLab / DX.',
    readback: 'Selecting a row makes SONAR print the plugin details in the status bar, e.g. '
      + '"Neural DSP, VST3, 64 Bit, In: 2, Out: 2".',
  },
  insertion: {
    works: false,
    tried: [
      { method: 'single click a plugin row in 查看插件', result: 'selection only, FX bin stays empty' },
      { method: 'double click a plugin row', result: 'selection only' },
      { method: 'drag the row onto the track FX area', result: 'no effect' },
      { method: 'right-click the track strip', result: 'no context menu appears' },
      { method: '视图 > 音源架视图 (0x81C4)', result: 'the rack view opens, but its instrument selector and slots expose no accessibility elements' },
      { method: 'the Track view toolbar buttons (+ / grid / list)', result: 'those toggle which columns the strips show, not insert anything' },
      { method: 'the context bar group (视图 / 选项 / 音轨 / 剪辑 / MIDI / Region FX)', result: 'these switch what the clip area edits; MIDI and Region FX open per-clip editing, not plugin loading' },
      { method: '在当前音轨上打开软音源 (0xA641)', result: 'posted, no observable effect and nothing to confirm against' },
    ],
    whatWouldMakeItPossible: [
      'an accessibility element representing a track FX slot or a rack slot, so a load could be '
        + 'confirmed rather than assumed',
      'a WM_COMMAND that inserts a named plugin by CLSID — SONAR has no such command; the command '
        + 'index contains nothing like "insert plugin <name>"',
    ],
    why: 'Every surface involved in loading a plugin — the plugin panel, the track FX slot, the '
      + 'synth rack — is drawn rather than laid out. The window reports the same element count '
      + 'whether they are open or closed, and none of their rows or slots carry an element. An '
      + 'agent can see them in a screenshot and click a coordinate, but cannot read back whether '
      + 'the load succeeded — and loading a plugin is not a safe thing to fire blind, since a '
      + 'plugin with a missing dependency is exactly what produces SONAR\'s '
      + '"One of the files this plug-in needs cannot be found" dialog.',
    options: [
      'insert the plugin by hand in SONAR (fastest and the only reliable route)',
      'use cw_add_track, which attaches SONAR\'s default instrument to a new track',
      'write the part as a .mid file — the program change selects a GM sound, so a recognisable '
        + 'instrument plays with no plugin loaded at all',
    ],
  },
  accessibility: {
    pluginPanelElements: 0,
    trackFxSlotElements: 0,
    synthRackSlotElements: 0,
    note: 'The window reports the same element count with the plugin panel open and closed. Track '
      + 'strips do expose their parameters (volume, pan, patch name, routing) — what is missing is '
      + 'any element representing an FX or instrument slot.',
  },
  keyboard: {
    tried: false,
    blockedBy: 'Synthetic key events need SONAR to be the frontmost window, and a background '
      + 'process kept taking focus during testing (steamwebhelper). Not conclusively ruled out — '
      + 'worth retrying when nothing else is competing for focus, by focusing a plugin row and '
      + 'pressing Return.',
  },
};

const INSTRUMENT_HINTS = /SI-|TTS-?1|Studio Instrument|Bass|Drum|Piano|String|Synth|Sampler|Sample|Orchestr|Kontakt|Serum|Massive|Sylenth|Zebra|Diva|Pigments|Keys|Organ|Choir|Vocal Synth|Synthesizer V|Guitar Rig|Ample|EZ|Superior|Addictive|Battery|FM8|Absynth|Reaktor|Omnisphere|Trilian|Stylus|MODO|ABPL|AGM|AGSC/i;

/**
 * Which plugin format a path represents. SONAR's plugin browser labels every
 * entry this way, so a search result that omits it reads as less trustworthy
 * than the browser it is describing.
 */
export function formatOf(file) {
  const f = String(file || '');
  if (/\.vst3$/i.test(f)) return 'VST3';
  if (/CompGate|Boost11|Sonitus|Behringer|\.dll$/i.test(f) && /Shared Plugins|Boost11|Shared Utilities/i.test(f)) return 'DX';
  if (/\.dll$/i.test(f)) return 'VST2';
  return undefined;
}

function guessKind(it) {
  const hay = `${it.name} ${it.file}`;
  return INSTRUMENT_HINTS.test(hay) ? 'instrument' : 'effect';
}

// --- menu layout (categories) ------------------------------------------------

let layoutCache = null;

/** The plugin menu layout: [{ folder, name, clsid, id }]. Effects only. */
export function loadLayout({ refresh = false } = {}) {
  if (layoutCache && !refresh) return layoutCache;
  const p = layoutPath();
  if (!p) { layoutCache = []; return layoutCache; }
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch (_) { layoutCache = []; return layoutCache; }
  const out = [];
  const folderRe = /<Folder Name="([^"]*)">([\s\S]*?)<\/Folder>/g;
  let fm;
  while ((fm = folderRe.exec(text)) !== null) {
    const folder = fm[1] || '(unnamed)';
    const body = fm[2];
    const plugRe = /<Plugin ID="(\d+)" CLSID="\{([^}]+)\}" Category="(\d+)" Name="([^"]*)" OriginalName="([^"]*)"/g;
    let pm;
    while ((pm = plugRe.exec(body)) !== null) {
      out.push({
        folder,
        id: Number(pm[1]),
        clsid: `{${pm[2].toUpperCase()}}`,
        category: Number(pm[3]),
        name: pm[4],
        originalName: pm[5],
      });
    }
  }
  layoutCache = out;
  return out;
}

/** Folder a plugin appears under, from the layout. Undefined for instruments. */
export function categoryOf(clsid) {
  if (!clsid) return undefined;
  const want = clsid.toUpperCase();
  return loadLayout().find((p) => p.clsid === want)?.folder;
}

// --- filesystem --------------------------------------------------------------

const VST_SEARCH_DIRS = [
  'C:/Program Files/Common Files/VST3',
  'C:/Program Files/Common Files/VST2',
  'C:/Program Files/Steinberg/VSTPlugins',
  'C:/Program Files (x86)/Steinberg/VSTPlugins',
  'D:/CAKEWALK/Shared Plugins',
  'D:/CAKEWALK/SI-Bass Guitar',
  'D:/CAKEWALK/SI-Drum Kit',
  'D:/CAKEWALK/SI-Electric Piano',
  'D:/CAKEWALK/SI-String Section',
];

/** Confirm a registered plugin's file is still on disk. */
export function fileExists(spec) {
  if (!spec) return false;
  const p = String(spec).replace(/\//g, '\\');
  return existsSync(p);
}

/** Walk the search dirs for .dll/.vst3 bundles. Shallow: maxDepth levels. */
export function scanDisk({ maxDepth = 3 } = {}) {
  const found = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (/\.(dll|vst3)$/i.test(e.name)) {
        const base = e.name.replace(/\.(dll|vst3)$/i, '');
        const key = base.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ name: base, path: full.replace(/\\/g, '/') });
        }
      }
    }
  };
  for (const d of VST_SEARCH_DIRS) {
    if (existsSync(d)) walk(d.replace(/\//g, '\\'), 0);
  }
  return found;
}

// --- public queries ----------------------------------------------------------

/**
 * Search plugins by name. Merges the registry inventory (authoritative, includes
 * instruments) with the layout's category label, and marks entries whose file is
 * missing.
 *
 * Also searches the scanned-but-unnamed entries by default, because those are
 * loadable plugins SONAR knows about and skipping them made searches disagree
 * with SONAR's own plugin browser.
 *
 * `withClsid` fetches each hit's CLSID via one extra registry read (≈10 ms each,
 * versus 10 s for the whole inventory) — only ask when you need to address a
 * plugin precisely.
 */
export function findPlugins(query, {
  kind, limit = 50, includeMissing = true, withClsid = false, includeScanned = true,
} = {}) {
  const q = String(query || '').toLowerCase();
  const inv = loadInventory();
  const out = [];
  for (const p of inv) {
    if (kind && p.kind !== kind) continue;
    if (q && !`${p.name} ${p.file}`.toLowerCase().includes(q)) continue;
    const present = fileExists(p.file);
    if (!present && !includeMissing) continue;
    const clsid = withClsid ? clsidFor(p) : p.clsid;
    out.push({
      name: p.name,
      kind: p.kind,
      format: formatOf(p.file),
      clsid,
      file: p.file.replace(/\\/g, '/'),
      category: categoryOf(clsid),
      present,
      source: 'inventory',
    });
    if (out.length >= limit) break;
  }
  if (includeScanned && out.length < limit) {
    const extra = scannedPlugins(query, { limit: limit - out.length })
      .filter((s) => !out.some((o) => o.file.toLowerCase() === s.file.toLowerCase()));
    out.push(...extra);
  }
  if (includeScanned && out.length < limit) {
    const extra = layoutOnlyPlugins(query, { limit: limit - out.length })
      .filter((s) => !out.some((o) => o.name.toLowerCase() === s.name.toLowerCase()));
    out.push(...extra);
  }
  return out;
}

/** Everything worth knowing about the plugin situation, in one call. */
export function pluginSummary() {
  const inv = loadInventory();
  const instruments = inv.filter((p) => p.kind === 'instrument');
  const effects = inv.filter((p) => p.kind === 'effect');
  const missing = inv.filter((p) => !fileExists(p.file));
  const layout = loadLayout();
  const folders = [...new Set(layout.map((l) => l.folder))].sort();
  const scannedOnly = inv.scannedOnly || [];
  const layoutOnly = layoutOnlyPlugins('', { limit: 1000 });
  return {
    // Three sources, and a search consults all of them. Reporting only the first
    // made searches disagree with SONAR's own browser for DX plugins and for
    // anything registered without a display name.
    sources: {
      named: { count: inv.length, from: INVENTORY_KEY },
      scannedUnnamed: { count: scannedOnly.length, from: INVENTORY_KEY, note: 'real and loadable, name derived from the file' },
      layoutOnly: { count: layoutOnly.length, from: layoutPath(), note: 'the DX-era effects; not in the VST inventory' },
    },
    searchable: inv.length + scannedOnly.length + layoutOnly.length,
    registered: inv.length,
    instruments: instruments.length,
    effects: effects.length,
    missingFiles: missing.length,
    scannedButNotRegistered: scannedOnly.length,
    scannedFiles: scannedOnly.map((f) => String(f).replace(/\\/g, '/')),
    layoutPath: layoutPath(),
    layoutEntries: layout.length,
    layoutFolders: folders,
    searchDirs: VST_SEARCH_DIRS.filter(existsSync),
    insertion: 'discovery only — see PLUGIN_INSERT_RECIPE / cw_plugin_insert_recipe',
    note: missing.length
      ? `${missing.length} registered plugins point at files that no longer exist. Instantiating one `
        + 'of those is what makes SONAR show "One of the files this plug-in needs cannot be found".'
      : 'Every registered plugin file is present on disk.',
  };
}

/** Instrument families worth reaching for when writing a song, best first. */
export const SONG_INSTRUMENT_PRIORITY = [
  { match: /^EZdrummer|^SSDSampler|^Superior|Drum Kit|^Battery|Drum/i, role: 'drums' },
  { match: /^EZbass|^Ample Bass|Bass/i, role: 'bass' },
  { match: /^EZkeys|^Piano|Electric Piano|^Keys|Rhodes/i, role: 'keys' },
  { match: /^Ample Guitar|^Guitar|Guitar/i, role: 'guitar' },
  { match: /BBC Symphony|Orchestr|String|Violin|Cello/i, role: 'strings' },
  { match: /Synth|Massive|Serum|Pad|Lead/i, role: 'synth' },
];

/**
 * Instruments available for songwriting, annotated with the role each is best
 * suited to and whether its file is present. Sorted so the first entry per role
 * is the one to pick.
 */
export function songInstruments({ limitPerRole = 4 } = {}) {
  const inv = loadInventory().filter((p) => p.kind === 'instrument' && fileExists(p.file));
  // Collapse repeats that share a name (the BandLab shell registers many).
  const byName = new Map();
  for (const p of inv) if (!byName.has(p.name)) byName.set(p.name, p);

  const roles = {};
  for (const p of byName.values()) {
    const hit = SONG_INSTRUMENT_PRIORITY.find((r) => r.match.test(p.name));
    const role = hit ? hit.role : 'other';
    (roles[role] ||= []).push({
      name: p.name,
      clsid: p.clsid,
      file: p.file.replace(/\\/g, '/'),
      category: categoryOf(p.clsid),
      // Kept so a caller can fetch the CLSID only for the one it picks.
      inventoryKey: `${p.file}*${p.index} ${p.name}`,
    });
  }
  for (const k of Object.keys(roles)) {
    roles[k].sort((a, b) => a.name.length - b.name.length);
    roles[k] = roles[k].slice(0, limitPerRole);
  }
  return roles;
}
