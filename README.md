# cakewalkmcp

**0.2.1 prerelease:** start with [QUICKSTART.md](QUICKSTART.md) and the current
[release notes](RELEASE-NOTES.md). The detailed measurements below include
historical experiments; the release notes take precedence for current limits.

The [2026-10-23 acceptance report](ACCEPTANCE-20261023.md) records actual SONAR
MIDI import/export, CAL editing, real-time MIDI recording, track writes and WAV
rendering. A Free License session exposed working track controls after loading
a CWP, so earlier paid-only explanations below are historical observations, not
a reliable availability rule. Inspect the current control tree.

For Chinese CP936 SONAR, choose `textEncoding:"gbk"` explicitly when writing or
reading track names; UTF-8 remains the default. Import a new arrangement into
an empty CWP or open its MIDI file directly. Import into an existing selected
track can merge content and override routing/mix. Select all before a whole
MIDI export. A synth template's created track name may differ from its filename;
inspect an unverified insert before retrying it.

Upgrade from 0.2.0: its `cw_save_state` can incorrectly call an imported MIDI
document safe to close. 0.2.1 reads the document tab, keeps positive dirty
evidence, and refuses close-safety when the state is unknown. This observation
does not authorize discarding work. Overlay results also distinguish attempted
closes from panels observed gone; track readiness reflects exposed controls.

Tests are offline by default: `npm test` or `npm run test:full` substitutes the
DAW/MIDI process boundary with a no-host fixture, while installer fixtures still
run in real PowerShell. Only `node run-tests.mjs --full --live-host` may send
commands to SONAR; use a disposable project. An offline pass is not a live-host
or audible-output certification.

The optional surface listener now requires the same 64-hex `CW_SURFACE_TOKEN`
in the SONAR and MCP process environments. With no valid token it does not
listen. Raw memory reads and vtable calls are permanently disabled, including
when authenticated. See [release notes](RELEASE-NOTES.md) before enabling it.

MCP server that gives an AI agent control over a running **Cakewalk SONAR** —
transport, views, dialogs, CAL, MIDI files and real-time MIDI.
This adapter detects CakeScript (T1) but does not implement its IPC dispatch;
T1-only tools return an explicit error and explain available alternatives.

SONAR's automation surface has changed between builds, so this server does not
assume one mechanism. It probes the running build and uses the best transport
that actually works, and when a tool cannot run it says why and what to use
instead, rather than timing out.

**阅读指南**：想安装使用 → [QUICKSTART.md](QUICKSTART.md)（中文，3 分钟）；是 AI agent →
[AGENTS.md](AGENTS.md)（工具选择与恢复手册）；要部署给别人 →
[deploy/README.md](deploy/README.md)。本文件是完整技术参考。

## Architecture

```
ZCode / Claude / etc.     MCP (stdio, JSON-RPC)
            │
            ▼
   cakewalk-mcp.js  ──┬── powershell bridge (user32)  ──┬── Sonar.exe
                      │                                 │
                      │                    ┌────────────┴────────────┐
                      │                    │                         │
                      │        T1  window-message            T2  wm-command
                      │    XCDLLMSERVER + WM_COPYDATA      GetMenuItemID + WM_COMMAND
                      │                    │                         │
                      │                    ▼                         ▼
                      │          CakeScript (Lua 5.4)        native menu handlers
                      │
                      └── powershell shim (winmm) ──► loopMIDI cable ──► SONAR MIDI in
                                                          T4  realtime-midi
```

Two PowerShell shims run side by side, both long-lived so per-call cost is one
JSON round trip rather than a process start: a user32 bridge for windows and
menus, and a winmm shim that holds the MIDI port handle open so sends stay flat.
The Node side never touches Win32 directly. Two details make this work on
Windows where the obvious approaches fail:

- Every `DllImport` that takes a string is declared `CharSet.Unicode`.
  PowerShell 5.1's `Add-Type` defaults to ANSI, and without the attribute
  `FindWindowW("Sonar", "Cakewalk Sonar")` silently returns 0.
- `GetMenuTree` reads ids from the *live* process. Hardcoding them would break
  on the next build; the ids differ between 32.08 and 32.10.

## Transports

The server probes these in order and reports the result in `cw_status`.

### T1 — `window-message` (fastest, richest)

SONAR's own embedded LLM agent talks to the app over IPC: a `XCDLLMSERVER`
window plus the registered messages `--*LLM_INIT*--` and `--*LLM_TOOL_CALL*--`.
Commands arrive as `write_cakescript` / `run_cakescript` tool calls into the
embedded **CakeScript (Lua 5.4)** engine, and `print()` output comes back.

This is the only transport that returns structured results, so every
track/note/mixer tool was designed around it.

> **This build detects T1 but does not dispatch it.** The bridge implements
> `status`, `menu`, `runmenu`, `overlays`, `probe` and `msgids` — there is no
> `init`/`toolcall` operation, so the `write_cakescript` / `run_cakescript` IPC
> is not wired. On a host that exposes the Assistant, `runTemplate` fails with
> `T1_CHAIN_UNIMPLEMENTED` rather than pretending. Everything that works here
> works through T2 (menu commands), T4 (MIDI) and the editing dialogs.

**It only exists when the build ships the Assistant panel.** SONAR creates the
window lazily when the panel is first opened. Present in **2026.08**
(32.08.0.040). **Removed in 2026.10** (32.10.0.021) — see below.

### T2 — `wm-command` (version-independent, fire-and-forget)

SONAR's client area is JUCE/Direct2D drawing, but the menu bar is a real Win32
menu. `GetMenuItemID` reads the live ids and
`PostMessage(hwnd, WM_COMMAND, id, 0)` executes them. Because the ids come from
the running process rather than a hardcoded table, this works across versions.

Verified working on 32.10.0.021: `0x882D` Preferences, `0xE140` About,
`0xA798` Video Engine Settings, `0xA783` Assistant panel toggle.

`cw_list_commands` and `cw_run_command` use this. Two caveats, both learned
from testing:

- **Modal panels swallow menu commands.** While the Assistant / command-palette
  panel is open, `WM_COMMAND` posts are dropped. The bridge closes those panels
  first (`cw_close_overlays`, or automatically inside `cw_run_command`).
- **Registering a command is not the same as handling it.** A build can list a
  command in its menu and its command index while shipping no handler. Posting
  such an id succeeds and does nothing. `cw_run_command` therefore diffs the
  window list before and after and reports `none-observed` when nothing opened,
  which is how you tell the two cases apart.

### T3 — `computer-use` (not driven by this server)

An agent with a computer-use runtime can drive the GUI directly. This process
cannot, so it only reports that the option exists.

### T5 — `uia-click` (reads and writes the track strips)

This one is new, and it is what made three long-dead tools work.

SONAR's track strips expose every control to accessibility — with a project open,
a plain UIA client sees 139 elements, 82 of them track controls, each named
`<label> on Track <N>` and carrying a live value. Reading that way has always
worked. Writing did not:

```text
controls advertise AXSetValue / AXToggle / AXPress
the runtime accepts the call ......... success
the value afterwards ................. unchanged
```

That is true, and it is only half the picture. **A real mouse event at the
control's own centre does change it**, and the value then reads back changed. So
T5 is three things together, and all three are needed:

1. **Locate** by name through accessibility — `手动静音 on Track 3`.
2. **Act** with a genuine click at the element's `BoundingRectangle` centre.
3. **Verify** by re-reading the value from a freshly resolved element.

`native/uia/cw_uia.ps1` does all three; `lib/track-ui.js` drives it. Proven on
mute, solo and arm, each toggled both ways and read back changed:

```json
{ "control": "mute", "track": 2, "requested": "打开",
  "before": "关闭", "after": "打开", "clicked": "922,642",
  "changed": true, "alreadyThere": false, "verified": true }
```

`verified` is the field to trust: it is true only when the value read back equals
the one requested. An idempotent write reports `alreadyThere: true` and
`verified: true` without clicking — `changed: false` there means "already right",
not "failed", and a caller that conflated the two would retry forever.

**Two things it cannot do.** A track scrolled out of the Track view is refused
rather than clicked, and the refusal explains why: SONAR still reports a
`BoundingRectangle` for a strip outside the view's clip region, and still reports
`IsOffscreen = false` for it, so a click at its centre lands on whatever the window
shows there. Measured on track 58 of a 71-track project — the button reported
`[905,378,33,33]` while the Track view's client area began at `y=474`. The guard
is therefore geometric, against the `CTRACKVIEW` container's own rectangle; an
`IsOffscreen` check alone is not enough and was tried first. And sliders
(音量 / 声像 / 增益) plus the routing buttons (输入 / 输出) are not driven here —
the sliders take a value through a pattern SONAR ignores, and the routing buttons
open a picker. Use `cw_midi_*` for volume and pan.

**A coordinate trap worth naming**, because it silently breaks every click: UIA
bounds and `SetCursorPos` are both *physical screen pixels* and agree as-is, but
only from a DPI-aware process. An unaware process gets virtualised coordinates
and every click lands 1.5x off on a 150% display — which is indistinguishable
from a control that ignores clicks. `native/uia/Mouse.cs` calls
`SetProcessDPIAware`, and `boundsToClick` returns the centre unchanged while
`boundsToRaster` is the one that divides.

**The PowerShell file must keep its UTF-8 BOM.** Strip it and PowerShell 5.1
reads the script as the ANSI codepage; the Chinese labels are then mis-decoded,
the clicks still work, and only the comparison against the requested state fails
— so `verified` comes back false on a write that actually succeeded.

**Two more hardening rules found the hard way.** First, a synthesised click has
no owner — it goes to whatever window sits at that screen point, and every early
success happened only because SONAR was in front. `Mouse.cs` now checks which
process owns the point, raises SONAR once if something else is on top, and
*refuses* rather than clicking into the wrong application (a misdirected click is
a wrong action elsewhere, worse than a failed one). Second, the first click of a
run can be consumed activating the window; the `set` verb retries once and
reports `attempts`, and its success test is the read-back, so a click that
already worked is never repeated.

**Renaming** (`cw_set_track_name`) rides the same mechanism but is not a single
click: double-click opens the strip's name editor, the text goes in through the
**clipboard** (SendKeys cannot type Chinese, and track names here usually are),
then Enter. Verified by reading the strip's name back — ASCII, Chinese, and
idempotent (a name already correct is reported `alreadyThere: true` without
touching anything).

**Plug-in chains arrive via track templates.** The Plug-ins pane shows all 275
plug-ins but is *drawn, not exposed* — with the browser open it contains no
accessibility elements at all, so clicking into it cannot confirm which plug-in
landed. A `.cwx` track template avoids that entirely: it carries a whole
pre-built strip (instrument, FX chain, sends, routing), SONAR names the new strip
after the template, and `cw_insert_track_template` finds that name in the strip
tree as its confirmation. 184 templates ship with the content installed —
instrument chains for Bass/Drums/Guitar/Vocals, multiband chains, Session
Drummer multi-outs. One limit, stated where the tool throws it: opening the
导入音轨模板 dialog is not scriptable (0x8536 dispatches unreliably and the
menu-bar element names do not match what is drawn), so the dialog is opened by
hand first and the tool drives everything after that point.

**Hardening for SONAR updates**, which is the difference between a demo and a
tool you can keep:

* **`cw_doctor`** — one command, five transport probes, a verdict and a remedy
  per channel. Run it FIRST after any SONAR upgrade: it names what degraded
  (label text changed? surface not re-added? modal dialog holding the menu?) and
  what to update. Its probes carry hard deadlines, so a hung path degrades to
  `unavailable` after 20s instead of hanging the diagnosis.
* **Label and state words are config, not code.** The strip labels (手动静音 /
  独奏 / 录制), the toggle words (打开 / 关闭) and the dialog confirm word live
  in one word-list block in `native/uia/cw_uia.ps1`, with English fallbacks
  (Mute/Solo/Record, On/Off, Open) tried in order, each overridable through
  `CW_UI_*` environment variables. A UI-text change across a SONAR version is a
  config override, not a code edit.
* **The minimized-window trap is detected.** A minimized SONAR reports element
  coordinates around −21000 (measured: strip at −21132 while the window rect was
  at −21333). Reads still work there; no click can land. `cw_doctor` reports
  `sonarMinimized: true` and says to restore the window, instead of leaving
  every write mysteriously `verified: false`.
* **The "ghost frame" state is named.** On 2026.10, after external foreground
  operations, the Sonar.exe process can stay alive while its main frame window
  is destroyed — audio and MIDI keep working, every UI path is dead, and the
  title probe used to read the HUD's caption. `Find-SonarMain` now refuses to
  fall back to HUD windows, and `cw_doctor` reports `frameGhost: true` with the
  one-sentence remedy: restart SONAR.

**Deploying this for someone else** is `deploy/`: `install.ps1` (prerequisites,
npm, then `cw_doctor` so installed means verified) and `uninstall.ps1` (removes
any registration, verifies the registry is clean). **There is no per-session
manual step.** See `deploy/README.md` for the ship list and for why the
control-surface DLL — formerly a required install step with a manual re-add
after every SONAR launch — is now opt-in and unused.

### T4 — `realtime-midi` (works on every build)

A loopMIDI virtual cable is a real Windows MIDI device, so it does not depend on
SONAR's scripting engine or on any menu command being handled. The server opens
the cable's OUT port through `winmm` and SONAR reads its IN port. This is the
transport that still *changes a project* on builds where CakeScript is gone, and
its latency is the MIDI driver's — milliseconds, independent of PowerShell.

On this machine the cable is **`Studio One AI Notes`** (MIDI out index 4, MIDI in
index 3). `cw_status` selects it automatically; the server also looks for any
port named `loopMIDI` or `Cakewalk` before falling back.

**The receive side is scriptable — no UI needed.** SONAR keeps which ports are
enabled in `%APPDATA%\Cakewalk\Sonar\TTSSEQ.INI`, not in the registry and not in
the project file:

```ini
[MIDI Input Devices]
0=Steinberg UR22C-1
1=Studio One AI Notes
MaxInPort=1
[MIDI Output Devices]
0=Steinberg UR22C-1
1=Studio One AI Notes
MaxOutPort=1
```

So `cw_enable_midi_port` writes that file (idempotent, keeps a `.bak`), and
`cw_midi_config` reads it back. This matters more than convenience: **it is the
only way to verify the receive side.** A send always returns `rc=0` whether or
not anything is listening, so without reading this file `cw_midi_status` could
only report that a port is open, never that SONAR is tuned to it.
`cw_midi_status` now reports `sonarReceives`, derived from this file.

SONAR reads the file at startup and when its MIDI Devices dialog is applied, so a
change here is not live in a running session until one of those happens.

Two limits to be honest about. MIDI cannot read project state, so there is no MIDI
equivalent of `cw_get_track` / `cw_get_notes` — see the next section for how that
gap is handled. And what a message *does* depends on the track or control that
receives it: a CC 7 moves a fader only where something is listening for it, which
means an armed track or an ACT assignment. Nothing in the message says which.

A note on testing this: loopMIDI does **not** loop a cable back to the same
process. Writing to `Studio One AI Notes` OUT delivers to *other* applications'
IN — and while SONAR is running it owns that IN, so a capture opened from here
gets nothing. `bridge/loopback.js` can capture a cable, but only one nothing else
holds. Do not read "0 messages captured" as a broken transport; check
`sonarReceives` instead.

## The one condition that decides everything: is a project open?

This is the single most important finding in this project, and an earlier round
of this work got it wrong. SONAR builds its menu bar and its track strips from
the open **document**:

| | no project open | project open |
|---|---|---|
| Window title | `Cakewalk Sonar` | `Cakewalk Sonar - [name.cwp*]` for a .cwp, or `name.mid - Cakewalk Sonar` for imported MIDI. The `*` dirty marker is drawn on the **document tab**, reported as `documentTab`; the frame caption does not always carry it. |
| Menu entries | 43 | **270** |
| Menus present | 文件 编辑 工具 帮助 | + **视图 插入 处理 工程 窗口** |
| Accessibility elements | 33–37 | **173** |
| Track controls | none | every strip, readable |
| Commands that respond | app-level only | + view, document, transport, per-track |

**An earlier measurement was taken with no document open.** It saw 43 menu
entries, concluded the `视图` menu and the CakeScript group were "registered
without handlers", and wrote that CakeScript had been removed from the build.
All of that was an artifact of the empty state. With a 16-track project open,
`视图 > CakeScript View`, `处理 > 运行 CakeScript 程序` and `视图 > AI Assist` all
respond — they open the membership panel on a free licence, which is a different
finding from "nothing happens".

`cw_document_state` reports which case you are in, read from the caption. It is
the first thing to check when a command appears to do nothing.

### Reading tracks works; writing needs a different transport

With a project open, the accessibility tree exposes every track control under
the name `"<label> on Track <N>"`:

```
slider  "音量 on Track 1"    = "101"                  actions=[AXSetValue]
slider  "声像 on Track 1"    = "0% 中"                 actions=[AXSetValue]
button  "录制 on Track 1"    = "关闭"                  actions=[AXToggle,AXPress]
button  "输出 on Track 1"    = "1-Steinberg UR22C-1"
button  "输入 on Track 1"    = "全通道"
button  "手动静音 on Track 1" = "关闭"
```

**Reading is accurate. Writing through accessibility does nothing.** A survey
across 3 tracks and 15 controls (声像 / 音量 / 力度+ / 手动静音 / 独奏) attempted a
write on each: **every call was accepted, none changed the value**, and a
screenshot confirmed the button state was genuinely unchanged rather than a
stale read. SONAR's accessibility layer reports mixer state for screen readers;
it does not accept it.

So the working split on this build is:

| Want | Use | Why |
|---|---|---|
| read track/mixer state | accessibility (`cw_track_controls`) | accurate snapshots |
| change volume / pan | **`cw_set_volume` / `cw_set_pan`** (MIDI CC7/CC10), or a **.mid file** | reaches the engine, not the UI |
| change project structure | `cw_add_track` | insert commands are dispatched |
| write notes | `cw_write_midi_file` + import | no note-level element exists |
| **edit existing notes** | **`cw_quantize_plan` → dialog → `cw_check_quantize`** | the dialog accepts writes; the export proves it |
| **create / delete notes** | **`cw_cal_run`** (`addNotes`, `deleteNotes`) | CAL is a note-level API and is not paywalled |
| **read notes** | **`cw_project` export → `cw_read_midi_file`** | no side effect; every field, every note |

### Setting volume and pan: two verified paths

**Path 1 — live CC over the cable** (`cw_set_pan`, `cw_set_volume`, `cw_apply_mix`).
CC7 is volume, CC10 is pan (0 = hard left, 64 = centre, 127 = hard right). The
message is addressed to the **MIDI channel the track listens on**, which is not
its position — read it from the strip's `MIDI 通道 on Track N` value. A channel
message only applies where a track is listening (armed, channel-assigned, or
bound to ACT); without a destination it is delivered and dropped.

**Path 2 — bake the values into a .mid and import it.** This is the more reliable
of the two because it needs no live routing. `cw_write_midi_file` emits CC7/CC10
at tick 0, which SONAR adopts as the track's initial volume and pan.

Verified end to end. A file written with:

```
Melody  ch1  program 0   volume 100  pan 64  (centre)
Bass    ch2  program 33  volume 112  pan 33  (49% left)
Pad     ch3  program 89  volume 86   pan 99  (56% right)
```

imported into SONAR and read back from the track strips:

```
Track 1  声道=1  音色=Acoustic Grand Piano   声像=0% 中     音量=100
Track 2  声道=2  音色=Electric Bass (finger) 声像=48% 左    音量=112
Track 3  声道=3  音色=Pad 2 (warm)          声像=56% 右    音量=86
```

Channel, GM patch name, pan position and volume all matched. **SONAR routes a
CC to the track carrying that channel**, so a track's notes, program change and
CCs must all share one channel — `cw_write_midi_file` checks this and warns
rather than writing a file whose mix lands on the wrong strip.

### The data level

There are **no note, clip or event elements** anywhere in the accessibility tree
— verified across a live 3-track project. What is exposed is the track-control
layer, not the data layer. On a build with no CakeScript transport, a `.mid` file
is therefore the only way to move notes in or out:

| Tool | Direction |
|---|---|
| `cw_write_midi_file` | compose notes and CCs, write a format-1 file, import it |
| `cw_read_midi_file` | parse a file — track names, channels, note counts, CC7/CC10 with the pan position spelled out |

Import is fully scriptable: `0xE101` (文件 > 打开) opens a standard MFC dialog,
and its filename field **does** accept `AXSetValue` — the contrast with the
track strips is what shows the limitation is in SONAR's drawn controls, not in
accessibility as such.

Two mechanics worth knowing:

- **Coordinate spaces differ.** Element bounds come back in *window* pixels
  (1920×902 here) while a click needs *render-frame* pixels (1280×601). Divide
  by `windowWidth/frameWidth` (1.5). Passing bounds straight through is refused
  as `outside 1280x601`.
- **Values go stale.** A second read of the same element can return the old
  value after an action. Confirm changes from a fresh screenshot.

## Driving SONAR's UI (measured)

Not everything is reachable, and the split is not obvious. What was actually
tested on 32.10.0.021 with a computer-use runtime:

| Surface | Reachable? | How |
|---|---|---|
| Menu bar (文件/编辑/工具/帮助) | **yes** | `AXExpand` a top-level item, then click the entry by index |
| Standard MFC dialogs (Preferences, any `#32770`) | **yes** | read elements by index; `AXToggle` / `AXPress` |
| Project views (track list, mixer, piano roll) | **no** | drawn with Direct2D; nothing in the tree — read from pixels |
| JUCE dialogs (Quick Start, 新建工程文件, palette) | **partial** | only title + close button appear; click by screenshot coordinate |
| Keyboard | **no** | synthetic key events are swallowed by SONAR |

Two of those are worth spelling out because they cost the most to discover.

**The menu bar works even where `WM_COMMAND` does not.** Expanding `文件` makes
every entry appear as a clickable element — including `新建(N)...`, which opened
the new-project dialog. The `视图` menu and the CakeScript group are the same
kind of command that `WM_COMMAND` cannot reach, so this is the path to them.

**Synthetic keystrokes do not reach SONAR.** `Alt+1`, `Ctrl+Shift+I`, typing
into a panel — all swallowed, repeatedly, with the window verified foreground via
`SetForegroundWindow` and an input-thread attach. Do not script SONAR by
keystroke. Click elements, or click coordinates.

### When the UI locks up

A JUCE modal dialog holds SONAR's UI thread. While one is open:

- computer-use calls time out (observed repeatedly)
- `WM_COMMAND` to the main frame is silently dropped

Recovering needs Win32, against the dialog's own hwnd — in this order, checking
after each:

```
SendMessage(hwnd, WM_COMMAND, 2 /* IDCANCEL */, 0)
SendMessage(hwnd, WM_COMMAND, 1 /* IDOK     */, 0)
SendMessage(hwnd, WM_CLOSE,   0, 0)
```

`WM_COMMAND`/IDOK is what cleared the stuck dialog that was blocking everything.
`WM_CLOSE` alone did nothing to it.

### Recipes for the operations that need the UI

`cw_probe_state` carries these alongside the read plan. They are written from
having done them, including what failed:

- **newProject** — Quick Start's caret, or 文件 > 新建. The 新建工程文件 dialog is
  JUCE: read the form from a screenshot. Pick a multi-track template (16-Track,
  4-Track) — an empty one leaves nothing to arm. `确定` stays disabled until
  `位置` exists on disk, and the dialog does not always re-validate after the
  directory appears, so it may need a field re-touched.
- **armTrackForMidi** — enable the cable (`cw_enable_midi_port`), then arm a MIDI
  track's R button, or assign the input to ACT. Without an armed destination the
  messages are delivered and valid but have nowhere to go.
- **insertMidiTrack** — needs the Track view open first.

## Plugins: discovery works, insertion does not

**Detection is accurate and covers three sources**, because SONAR registers
plugins in three different places and reading only one made searches disagree
with SONAR's own plugin browser:

| Source | Count | What it holds |
|---|---|---|
| Registry inventory, named | 653 | `"<dll path>*<index> <name>"` + `clsidPlug` |
| Registry inventory, scanned but unnamed | 293 | real and loadable — `Battery 4`, `BBC Symphony Orchestra`, `Melodyne`, `Boost11` |
| Menu layout only | 262 | the DX-era effects (`Compressor/Gate`), not in the VST inventory |
| **Searchable total** | **1208** | |

A spot check across formats returns **12/12**: `Archetype Mateus Asato` (VST3),
`EZdrummer 3`, `Kontakt 8`, `Massive X`, `Boost11` (DX), `Compressor/Gate` (DX),
`Melodyne`, `Battery 4` and others — each with its format, kind, and whether the
file is still on disk.

Two read optimisations worth noting. The inventory read was **10 415 ms** with
`reg query /s` (which recurses into all 946 subkeys for their values) and **74 ms**
with the top-level query (which returns the subkey names, where the path and
plugin name already live). CLSIDs are now fetched per-plugin at ~10 ms when
actually needed.

### What cannot be done: attaching a plugin to a track

Measured on 32.10.0.021, and this is a real limitation:

| Step | Result |
|---|---|
| Open the plugin browser (`查看插件`, `0x8A59`) | **works** — a JUCE panel docks on the right with a category tree |
| Expand a category | **works** — Dynamics lists `Archetype Mateus Asato`, `BL 1176`, `Boost11`, `Curves Resolve`, `Gater`, … |
| See each plugin's format | **works** — rows are tagged `VST3` / `VST2` / `BandLab` / `DX` |
| Read which plugin is selected | **works** — the status bar reports `Neural DSP, VST3, 64 Bit, In: 2, Out: 2` |
| **Insert it onto a track** | **does not work** — single click, double click and drag all leave the FX bin empty |

The reason is consistent with everything else here: the plugin panel is *drawn*,
not laid out. The window reports **144 accessibility elements whether the browser
is open or closed** — the category rows, plugin rows and the `音源架` / `Fx Audio FX`
tabs carry no elements at all. And the track strips expose no FX-slot element
either, so there is nothing to drop onto by name.

`cw_plugin_insert_recipe` reports this. The workarounds, in order of how well
they work:

1. **Insert the plugin by hand** — fastest and most reliable.
2. **`cw_add_track`** — inserts a track with SONAR's default instrument attached,
   which is enough to hear a MIDI part.
3. **Write the part as a .mid** — the program change picks a GM sound, so a
   recognisable instrument plays without loading any plugin at all. This is how
   the song in this repo gets its piano, bass and pad.

## Mixing: what is reachable

Track volume and pan are **readable** through accessibility and **not writable**
(see the survey above). Two levers actually move them:

| Lever | Status |
|---|---|
| Live CC7/CC10 over the cable (`cw_set_volume` / `cw_set_pan`) | reaches SONAR, **but does not move the strip** unless the track is monitoring that channel — and arming cannot be set through automation either |
| **CC7/CC10 baked into a .mid, then imported** | **works, verified end to end** |

The distinction is not obvious and cost time to establish: a live CC is delivered
to SONAR and reported `ok`, so it *looks* like it worked. Reading the strip back
after sending a mix showed the old values still in place — the message had gone
nowhere because nothing was listening.

Measured end to end. A file written with:

```
Melody  ch1  program 0   volume 100  pan 64  (centre)
Bass    ch2  program 33  volume 112  pan 46  (29% left)
Pad     ch3  program 89  volume 78   pan 82  (29% right)
```

imported and read back from the strips:

```
Track 1  声像=0% 中    音量=100   音色=Acoustic Grand Piano
Track 2  声像=28% 左   音量=112   音色=Electric Bass (finger)
Track 3  声像=29% 右   音量=78    音色=Pad 2 (warm)
```

Volume matched exactly on all three; pan matched to within SONAR's rounding.

**A gotcha that will bite anyone iterating on a generated file:** opening a
filename that is already the loaded document does nothing — SONAR treats it as
already open and skips the reload. Verified by rewriting `song.mid` with new
values and re-opening it (strips unchanged), then copying to `song-mix-v2.mid`
and opening that (new values appeared immediately). Write to a new filename each
time, or close the document first.

On the honest limits of "mixing" here: with no way to insert plugins, there is no
EQ, compression or reverb to dial. What remains is the balance — level and
placement of the parts. `mix.mjs` writes a full arrangement with that balance
baked in.

## Coverage: what is exposed, and where the gaps really are

Measured by taking SONAR's own command index (1208 searchable entries, of which
257 appear in the live menu bar) and subtracting what the adapter exposes. The
gaps fall into two very different kinds, and telling them apart is most of the
work:

| Area | Commands | Exposed | Why the rest is missing |
|---|---|---|---|
| Transport / timing | 32 | 14 | the rest are transport buttons — no elements, no readback |
| Project files | 28 | 9 | export and import need a selection; the rest are covered |
| Track management | 64 | 11 | most are per-track menu items with no distinct capability |
| Views | 84 | 9 | opening a view is one operation; the other 75 are layout variants |
| Note / MIDI | 39 | 4 | **note-level data has no accessibility surface at all** |
| Selection / navigation | 63 | 12 | added this round — see below |
| Markers / arranger | 46 | 12 | markers added; the arranger is unprobed |
| Mixing / routing | 22 | 2 | sends and buses are **drawn** — readable, not writable |
| Editing | 30 | 3 | most need a selection first, and several are destructive |
| Plugins | 24 | 0 | **insertion cannot be driven** — see the plugin section |

Two of those deserve spelling out, because "not covered" means something
different in each case.

**Note-level data has no surface — for READING. It does for WRITING.** A
project's notes are drawn in the clip area and there is no `Note` element
anywhere in the tree — verified across a 3-track project. That is why
`cw_write_midi_file` / `cw_read_midi_file` exist: a `.mid` file is the only way
notes cross the boundary.

An earlier version of this section stopped there and implied notes could not be
*edited* either. That was wrong, and the cost of the mistake is worth recording:
the claim was copied from the reading limitation without being tested. Editing
notes works, through the dialog behind `处理 > 量化` — see
[Editing notes](#editing-notes-the-one-round-trip-that-proves-itself). Reading
them still has no surface, so the only way to confirm an edit is to export and
parse the file, which is what the adapter does.

**Editing commands are precondition-gated.** 量化 / 移调 / 拆分 probed as
`unconfirmed` — but an edit command on an empty selection is *expected* to do
nothing, so `unconfirmed` here does not distinguish "broken" from "nothing was
selected". Satisfying the precondition turned all three into open dialogs; see
the next section.

### What this round added

**Markers, and the pattern behind them.** `工程 > 插入标记` (`0x807F`) opens a
standard MFC dialog titled 标记, and **accessibility can write to it**:

```js
// 13 textfield "名称(N):"   => setValue "Intro"
// 10 textfield "时间(T):"   => setValue "1:01:000"
//  5 button    "确定"
```

That created a marker, which was then read back from the marker list — `视图 >
标记` shows a **table** with columns 时:分:秒帧 / Lk / 小节:节拍:嘀嗒 / 音高 / 名称,
and a table is readable. So the round trip closes: **write through a dialog, read
through a table.**

That is the generalisable finding. SONAR's own controls are drawn and ignore
writes; a dialog behind them is not. Whenever a drawn surface has a command that
opens an MFC dialog, use the dialog — it is the one place writes land.

**Selection and navigation.** `cw_navigate` covers 19 commands across selection
(all / none / by time / from-now / to-now / to-end), now-time movement (next and
previous bar, next and previous marker) and markers (insert, project start/end,
remove). Each record says how it can be confirmed: `dialog` for the two that open
one, `screenshot` for the rest, with what to look at named — because a selection
and a now-time change are drawn and this process cannot see either.

`cw_markers` carries the dialog's element names, the readback path, and the limit:
**deleting a named marker has no command and no dialog** — only the project
start/end markers have remove commands. Removing an arbitrary marker needs the
list UI.

## The editing layer, and why "nothing happened" has three causes

This round found the other half of the measurement problem. Probing 量化 / 移调 /
分割剪辑 with no selection reported `unconfirmed` for all three — and the tempting
reading was "these do not work". They work. An edit on an empty selection is
*supposed* to do nothing:

```
no selection   0x8061 处理>量化     unconfirmed
after 编辑 > 选择 > 全部:
               0x8061 处理>量化     opens #32770 「量化」
               0x8066 处理>移调     opens #32770 「移调」
               0x8012 分割剪辑      opens #32770 「分割剪辑」
```

All three dialogs are standard MFC, so their fields accept `AXSetValue` — the
same property that makes the file and marker dialogs writable. `cw_edit`
satisfies the selection precondition automatically, which is the difference
between a command that looks broken and one that opens its dialog.

So a probe result of "nothing happened" has **three** causes on this build, and
only one of them is a limit of the adapter:

| Cause | How to tell | What it means | What to do |
|---|---|---|---|
| `drawn-not-exposed` | it is a toggle, transport action, selection or fader | it worked; the result is pixels | confirm with a screenshot |
| `precondition-missing` | it is an edit, an export, or acts on a selection | the command is fine, the state was not | satisfy the precondition and retry |
| `gated-by-licence` | a `PaywallWindow` appears | needs a paid tier on this install | report it and stop |

`cw_no_effect_causes` carries this taxonomy. The third cause is new: two arranger
commands (添加编曲音轨 `0xA63B`, 复制编曲音轨 `0xA63E`) open the membership panel,
which is a licence gate rather than a missing feature — an arranger track
nonetheless appeared in the tree, so the arranger itself is present.

Destructive edits (split, merge, normalize, reverse, remove-silence, fade) require
the caller to name the command, on the same reasoning as `cw_project`:
`cw_edit({command:'normalize'})` is refused; `{confirm:'normalize'}` runs.

## Editing notes: the one round trip that proves itself

This is the only place in the adapter where a change to project *data* is both
made and verified, so it is worth spelling out end to end.

Notes cannot be read through any automation surface. They can be **edited**,
because the edit commands open real MFC dialogs and accessibility writes to those
land. That splits the problem in two: make the change through the dialog, prove
it from the file.

```
编辑 > 选择 > 全部        0x804C   gives the edit something to act on
处理 > 量化               0x8061   opens #32770 「量化」 — 46 readable elements
  AXSetValue 时值(U):     43/textfield   "16 分音符"   ← the textfield, NOT the combobox at 41
  AXSetValue 强度(S):     31/textfield   "100"         ← must be set explicitly; it persists
  AXSetValue 灵敏度(W):    25/textfield   "100"
  AXPress    确定         11/button      commits; the close is ASYNCHRONOUS
文件 > 导出 > 标准 MIDI 文件  0xA659     writes 保存副本 → the tick positions are now data
cw_read_midi_file                       reads them back
```

**The measurement, with a control group.** A test file was written with eight
notes deliberately off every grid:

| | ticks | on the 16th grid? |
|---|---|---|
| written by us | 30 530 935 1477 1877 2461 2862 3404 | no |
| exported with **no edit** | 30 530 935 1477 1877 2461 2862 3404 | no |
| quantized at **100%** | 0 480 960 1440 1920 2520 2880 3360 | **yes** |

The middle row is the control, and it is what makes the bottom row mean
something: export alone moves nothing (zero drift), so every tick in the third
row is the edit. `cw_check_quantize` reproduces the third row from the first by
arithmetic alone.

**Two mistakes, both recorded because both produced a wrong answer.**

*Measuring too early.* `AXPress` on 确定 is accepted, the dialog closes, and the
window list is checked in the same breath — which still shows the dialog. The
obvious reading is "the press did nothing". It did. The close is asynchronous;
wait, then look.

*No control group.* The first run used the dialog's persisted default of **50%
strength**, which moves each note only *part* of the way to the grid: 30 → 16,
530 → 506, 935 → 948. Those deltas (10–30 ticks, mixed directions) look exactly
like export rounding noise, and "quantize is broken" was the conclusion — until
exporting the same file with no edit returned the source ticks unchanged. That
control made the movement real, which pointed at the strength setting, which was
the actual cause.

How well "half way" actually describes 50% is worth stating precisely, because
the model in `predictQuantize` is linear and the measurement is not quite:

| source | measured @50% | model | difference |
|---|---|---|---|
| 30 530 935 1477 1877 2461 2862 3404 | 16 506 948 1460 1899 2432 2872 3383 | 15 505 948 1459 1899 2491 2871 3382 | 1 1 0 1 0 **59** 1 1 |

Seven notes agree to within a tick of rounding. One — the 2461 → 2432 case —
does not, by 59 ticks. One sample cannot say whether that is `灵敏度`
interacting with strength, a grid-line tie, or something else, and fitting a
constant to it would be inventing precision. So the model is marked `exact` only
at 100% strength (where it matched all eight notes) and `approximate` otherwise.
That labelling is what keeps a mismatch at partial strength from being read as a
failure.

The general rule this leaves behind: **when a change looks like noise, export a
no-edit control before concluding anything.** It costs one file write.

`cw_note_edit_help` carries the whole procedure, `cw_quantize_plan` states the
field writes for a given setting, and `cw_check_quantize` judges a result from
two tick lists.

What is still not established: only 量化 has been measured field by field. 移调
and 分割剪辑 open the same class of dialog and should behave identically, but
their element indices are not recorded. Checkbox state inside the dialog is not
exposed either — which boxes are ticked must be read from a screenshot.

## A measurement trap worth knowing: the window diff is blind

`cw_verify_commands` decides a command worked by diffing the top-level window list.
**That test cannot see a change that happens inside the existing frame** — which is
most of SONAR's UI. Probing the uncovered commands showed the cost directly:

| Command | Window diff | What actually happened |
|---|---|---|
| `0x8072` 视图 > 速度 | no change | **a tempo track appeared** (`TEMPOTRACKVIEW` in the tree) |
| `0x82CE` 显示/隐藏总线区域 | no change | the track view repainted |
| `0x80B9` 循环开关 | no change | it is a toggle — it can never open a window |

An earlier round read "no window change" as "nothing happened" and concluded
several commands were unhandled. **That was a measurement artefact, not a
property of the build.**

The fix is not a better heuristic — it is admitting the limit. From this process,
a non-window-changing command **cannot be confirmed**. `cw_command_evidence`
records which commands are confirmed and which are not, grouped by what kind of
change they make, and names the witness that would settle each unconfirmed one:

| Evidence class | Who can observe it | Example |
|---|---|---|
| `window` | this process | `编辑 > 历史` opens a `#32770` dialog |
| `elements` | computer-use runtime | `视图 > 速度` adds `TEMPOTRACKVIEW` |
| `screenshot` | computer-use runtime | `循环开关` flips a button |
| `accepted` | nobody — posting is not confirming | any toggle with no readback |

`cw_run_command_classified` returns `confirmed` / `did-nothing` / `unconfirmed`
with the class behind it, instead of claiming success from "nothing errored".

## Transport and timing

The transport buttons are the one surface no automation reaches: they are drawn,
so they carry no elements, and computer-use key events need SONAR frontmost. What
is reachable is the command layer:

| Command | id |
|---|---|
| 播放/停止 / 停止 / 录制 | `0x801D` `0x801F` `0x801C` |
| 循环开关 / 设置循环选区 | `0x80B9` `0x80FE` |
| 节拍器（回放 / 录制） | `0x8171` `0x8172` |
| 视图 > 速度 / 拍号调号 | `0x8072` `0x8073` |
| 插入速度变更 / 拍号变更 | `0x807D` `0x807E` |

**Every one changes state without opening a window**, so `cw_transport_command`
posts and reports intent — it does not claim the transport moved. It returns the
`expectedVisibleEffect` naming what a runtime should look at.

For tempo and time signature specifically, there are two routes and they are not
equivalent. Writing them into a `.mid` and importing sets the piece's tempo map
exactly with no interaction (verified: a file written at 120 BPM imported and the
transport reported 120.00 / 4/4). Inserting a change at the now-time is a
different operation and only affects the position it lands on.

## Document lifecycle, with a guard on the destructive parts

`cw_project` runs new / open / save / saveAs / close / exportAudio / importMidi /
revert. The commands that discard work require the caller to **name** what it is
destroying:

```js
cw_project({ command: 'close', confirm: 'close' })   // runs
cw_project({ command: 'close' })                     // refused: NEEDS_CONFIRMATION
cw_project({ command: 'close', confirm: true })      // also refused
```

A bare boolean is deliberately not enough — the point is that the caller has to
say which command it means. This guard exists because probing closed the open
project with no prompt at all (a clean project closes silently) and there was no
undo. `cw_save_state` reports the modified flag first, so a caller can see what is
at stake before choosing.

## Reading project state on 2026.10

This build exposes **nothing** about project content through any automation
interface. Verified on 32.10.0.021:

| Interface | Result |
|---|---|
| `WM_GETTEXT` on every window SONAR owns | empty string — no track, clip or mixer text anywhere |
| UIA `TreeScope::Descendants` on the main window | 19 elements, all containers (`MDIClient`, `AfxControlBar140u`, `CCtrlBar*`, the JUCE shell) |
| MSAA `AccessibleObjectFromWindow` | control bars only, ≤16 children |
| computer-use on the main view | 31 elements: menu bar, toolbar captions, pane names — no project content |
| computer-use inside the Preferences dialog | **136 elements**, fully readable and clickable |

The split is the useful part: **standard MFC dialogs are fully automatable** —
that is how the MIDI input port was enabled, by reading the checkbox rows and
toggling them — while **project views are drawn, not laid out as windows**, so
they are invisible to every accessibility client and only readable as pixels.

The server therefore does not pretend to read state. Three tools handle the gap:

| Tool | What it does |
|---|---|
| `cw_probe_state` | A plan for a topic (`overview`/`tracks`/`mixer`/`notes`/`selection`/`all`): which SONAR surface carries each fact, and the steps to capture it. Notes go through the Event List view because tabular text survives reading far better than a piano-roll render. |
| `cw_report_state` | Accepts what a computer-use agent observed and caches it, in the same shape the CakeScript tools returned (`tracks[]`, `notes[]`, `now`, `tempo`, `loop`). |
| `cw_get_state` / `cw_list_state` | Read the cache back, with staleness (30 min) and an explanation when empty. |
| `cw_surfaces` | Reference: every surface that carries state and what can be read from each. |

This keeps the MCP server's job honest — it automates what is automatable — and
leaves the pixel reading to whatever agent has a computer-use runtime, with the
knowledge of *where to look* shipped from here.

## Status as of SONAR 2026.10 (32.10.0.021)

Tested 2026-10-12. What is true, after correcting an earlier misreading:

1. The **助理 (Assistant) menu entry** opens the **command palette**, not an AI
   chat panel. `XCDLLMSERVER` is never created, so the `write_cakescript` /
   `run_cakescript` IPC has nowhere to land. **The T1 transport is gone.**
2. **The CakeScript commands are not gone.** They are absent from the menu bar
   only because no project was open at the time. Open one and
   `视图 > CakeScript View` (`0xA797`) and `处理 > 运行 CakeScript 程序`
   (`0xA78D`) are both present and both respond — on a free licence they open
   the membership panel. Whether CakeScript would actually *run* on a paid
   licence could not be established on this machine.

Both halves of that were re-checked against the binary and the live UI later,
and the picture is firmer than "the entry point is gone":

- `write_cakescript` (6 hits), `run_cakescript` (5), `get_project_summary` (7)
  and `CakeScript` (3,704) are all present as **string literals in Sonar.exe**,
  together with their full tool descriptions (`invalid_tool_call`,
  `permission_denied`, `script_write_failed`, …) and an `Anthropic` API URL.
- The engine is bound via **sol2**: the binary is full of
  `sol::detail::ctti_get_type_name<CakeScript::ITrack>` / `IClip` /
  `IMIDIEventAdv` / `IAutomation` / `IArrangement` / `ITakeLane` /
  `IClipboard` symbols, plus the literal `Lua 5.4`.
- **`XCDLLMSERVER` still appears once** as a string, but no such window is ever
  created, and `LLM_INIT` / `LLM_TOOL_CALL` do **not** appear as literals at all
  — they are `RegisterWindowMessage` ids, which is why scanning for them finds
  nothing. (An earlier note in this project claimed "24 `--*LLM_*--` registered
  window messages"; that was wrong and is corrected here.)
- Posting `0xA78D` with a project open raises a `JUCE_1a13a4b5ecf` window titled
  **`PaywallWindow`**, whose rendered content is the Sonar **Membership** upsell
  ("Unlock Sonar's complete toolset and features with Membership" — unlimited
  samples, Pro guitar tools, Elastique Pro, POWR dithering, early access).

So the correct statement is **gated, not removed**. The distinction is not
pedantic: a licensing gate lifts with a subscription, while a removed engine
needs a new build. And it explains the shape of the rest of this adapter — the
whole reason the editing dialogs (`AXSetValue` on `#32770`) and the MIDI cable
carry the write path is that the one broad, structured API is behind that panel.

### What the paywall actually blocks — and what it does not

The licence banner is visible in the app: `Free License  Upgrade your experience
with Membership`, with a `Get Membership` button. On that licence,
`处理 > 运行 CakeScript 程序` opens the upsell instead of a file chooser. So the
question that matters is: **which capabilities are lost with it?**

The answer came from SONAR's own command index. `cwsearch.dat` (SQLite, at
`%APPDATA%\Cakewalk\Sonar\`) holds **1,315 rows**; **481 carry a live `CMD_ID`**
— a Win32 menu command id, postable with `WM_COMMAND` — and **186 of those are
on the running build's menu bar** right now. The index also has a `SCRIPT_CMD`
column naming the CakeScript verb behind each id, so the paywalled API can be
matched, entry by entry, against what the menu can reach anyway.

Mining the `处理` (Process) menu for rows with a live id gives **30 commands**,
and roughly a third of them are **note-level processors**. Every one of the nine
below was opened on 2026-10-15 and its field table recorded; four were driven end
to end and the result read back out of an exported file:

| Command | id | What it does to notes | Measured |
|---|---|---|---|
| 量化 Quantize | `0x8061` | start times → grid | **round trip verified** |
| 移调 Transpose | `0x8066` | pitch by an interval (signed) | **round trip verified** |
| 力度 Scale Velocity | `0x8067` | velocities, as a percentage ramp | **round trip verified** |
| 音长 Length | `0x8064` | durations and/or start times, scaled | **round trip verified** |
| 倒置 Retrograde | `0x8065` | mirrors the pitch contour in place | **round trip verified** |
| 时间匹配 Fit to Time | `0x8068` | stretches the selection to a target end time | fields |
| 律动量化 Groove Quantize | `0x8062` | timing/duration/velocity against a groove | fields |
| 移动 Slide | `0x8043` | shifts events by a signed amount in a chosen unit | fields |
| 轻移 Nudge ×8 | `0x846F`…`0x8531` | pitch (up/down) and time (left/right) | no dialog; step sizes measured |
| 查找/更改 Find/Change | `0x8063` | **selects** events by a filter — it does not edit | fields |

**This corrects the project's earlier claim that note editing needs CakeScript.**
It does not. Note editing has been reachable all along through these commands.

The verified four, with the arithmetic that makes them proofs rather than
impressions. Source material was a generated C-major scale at
`60,62,64,65,67,69,71,72`, velocities 100, durations 400 ticks on a 480 grid:

- **量化** — source ticks `30 530 935 1477 1877 2461 2862 3404` at 100% became
  `0 480 960 1440 1920 2520 2880 3360`; a no-edit control export showed zero drift.
- **移调** — wrote `3` into `数量(A)` (element 25), pressed 确定, exported:
  `63,65,67,68,70,72,74,75` — every note +3 semitones, control unchanged.
- **力度** — wrote `50` into both `开始(B)` (element 9) and `结束(E)` (element 7),
  pressed 确定, exported: every velocity `100 → 50`.
- **音长** — wrote `50` into `按照(B)` (element 24) and pressed 确定: every
  duration `400 → 200` **and** every start tick `0,480,960… → 0,240,480…`, because
  `时值(D)` and `开始时间(S)` are both ticked by default. A caller wanting only the
  durations to change must untick element 27 first.
- **倒置** — no dialog at all. Afterwards the pitches read
  `75,74,72,70,68,67,65,63` **at the same ticks**: it mirrors the pitch contour
  and leaves the rhythm alone. The earlier description ("reverses the order of the
  notes") was wrong, and 倒置 is fully automatable without any GUI runtime.

### Two corrections the measurements forced

Both were plausible-sounding claims that survived review and were still wrong.

**查找/更改 is a selector, not a replacer.** The record said "batch-replaces event
properties". Opening it shows a dialog titled **`事件过滤器 - 搜索`** with 141
elements: per-event-type rows (音符, 控制器, RPN, 弯音轮, 音色 …) each carrying
`包含`/`排除` checkboxes and min/max ranges for 音高, 力度, 时值, 通道, 拍 and 嘀嗒.
It narrows a selection for another command to act on. Nothing in it modifies an
event.

**轻移 > 设置 is not a nudge dialog — it is the global preferences window.**
Posting `0x8532` opens **参数设置** on its 轻移 page. The three steps are
independently configurable, not a small/medium/large ramp:

```
轻移 1 = 10 毫秒      轻移 2 = 1 帧      轻移 3 = 2 帧
```

each with 绝对时间 / 音乐时间 / 使用对齐设置 radios. That explains something that
had looked like a broken command: **a nudge appears to do nothing because step 1
moves 10 ms**, far below one MIDI tick at ordinary tempos. It is also a
*preference* write, which undo does not cover and which outlives the project — so
the command is marked destructive with that reason stated.

### The one limit that shapes all of this

Every number in these dialogs is backed by SONAR's **`CC:SpinCtrl`**, and the
`Edit` beside it is a shadow control. A raw `WM_SETTEXT` on that Edit reads
straight back — and then `GetWindowText` on the same handle returns empty again,
because the value the dialog uses lives in the SpinCtrl. **The write must go
through an accessibility runtime** (`AXSetValue`, or computer-use's `setValue`),
which is exactly what the field tables are for, and why a pure-Win32 path cannot
replace one.

A companion finding that makes this cheap to exercise: **these dialogs open
regardless of whether the selection contains anything.** Select-all on a project
whose tracks are all empty still opens 量化 and 移调 with every field readable and
writable. Only the commit needs real notes to be meaningful.

### What each capability actually needs

| Capability | Requirement |
|---|---|
| Track / note / mixer tools (`cw_list_tracks` …) | **T1** — unavailable on 2026.10 |
| Note editing with a dialog (quantize, transpose, velocity, length, fit, groove, slide) | a selection + **an accessibility runtime** — no CakeScript, no licence |
| Note editing without a dialog (retrograde, nudge ×8) | a selection — **posting the id is the whole operation** |
| **Creating, deleting and reading notes** | **CAL** — a selection + the file dialog. No licence. See below |
| Selecting events by filter (`cw_edit` findChange) | a project open; it changes no data |
| `cw_run_command` (menu commands) | a project open, for the view/document commands |
| `cw_midi_*` | the cable enabled as a SONAR input — verified via TTSSEQ.INI |
| Reading track state | a project open + a computer-use runtime |
| Changing track state | MIDI; the UI path is read-only |
| **Track rename, mute, channel/port routing** | **CAL's track builtins** — no licence |
| Solo / record-arm | selection-based menu commands (`0x809F`, `0x80E2`) — no licence |
| **Undo / redo / inspect the undo stack** | `0xE12B` / `0xE12C` / `0x8044` — no licence, no dialog for the first two |
| Plugin insertion | no scripting route; a control-surface COM plugin can set it by strip index |

Two rows carry the weight. **Nine note operations** are available on a free
licence through the edit dialogs, five verified end to end, and two of those
(倒置 and the nudges) need no GUI automation at all — they are plain
`WM_COMMAND` posts. And **CAL closes the three gaps the dialogs cannot reach**:
creating, deleting and reading notes. That is a far larger surface than "no note
editing", which is what this project claimed before measuring.

### CAL — notes can be created, deleted and read on a free licence

The `处理` menu has a second macro language, and it is **not** behind the
paywall. `处理 > 运行 CAL 程序` (`0x806A`) opens an ordinary file dialog listing
`*.CAL` — not the membership panel that `0xA78D` (CakeScript) opens — and the
interpreter behind it reads and writes note data directly.

Measured 2026-10-15, every result read back out of an exported `.mid` parsed by
`cw_read_midi_file`. Source material was a generated C-major scale,
`60,62,64,65,67,69,71,72`, velocities 100, durations 400 ticks:

| Operation | CAL | Result |
|---|---|---|
| **modify** | `(= Note.Vel 64)` | 8 notes, every velocity `100 → 64` |
| **create** | `(insert t ch NOTE (+ k 12) v d)` ×3 | 8 → **32** notes; each new pitch exactly `source+12/+16/+19`, each at its source tick |
| **delete** | `(if (>= Note.Key 80) (delete))` | 32 → **16**; exactly the 16 above the threshold, none left |
| **read** | summary written into the track name | `Q:n16,lo60,hi79,v64-64,d6400,t0-3360` — matches the project exactly |

`cw_cal_plan` writes nothing and posts nothing; `cw_cal_run` writes the script
into the CAL folder, posts `0x806A`, and reports the dialog steps for an
accessibility runtime; `cw_cal_help` carries the language reference.

#### The language, as far as the 37 shipped scripts establish it

There is no CAL documentation on this machine — no help file, no reference, and
the CakeScript guide mentions CAL only as what CakeScript replaced. Everything
below is read out of the scripts themselves, and where a thing is not observable
there it says so rather than guessing.

- **Structure.** A sequence of parenthesised expressions. The
  `prolog / body / epilog` split in the shipped scripts is a **convention, not
  grammar**: the body slot is re-evaluated once per selected event, and a script
  may equally be one `(do …)` or one bare `(if …)`. `TICKINFO.CAL` proves the
  body slot is a slot — it puts `NIL` there with a comment saying this makes the
  routine run once instead of per event. `(forEachEvent expr)` is the explicit
  form; `LEGATO.CAL` uses both.
- **Variables.** `(int name init)`, `(dword …)`, `(word …)`, `(string …)`. A
  prolog variable persists across the walk — that is the only cross-event state,
  and `SINGLE.CAL` uses it (with a `-1` sentinel) to reach the *previous* event's
  fields, which no builtin offers.
- **Fields.** `Event.Kind`, `Event.Time`, `Event.Chan`, `Note.Key`, `Note.Vel`,
  `Note.Dur`, `Control.Num`, `Control.Val`, `Wheel.Val`, `ChanAft.Val`.
  `Event.Kind` and `Event.Chan` are read-only in every shipped usage;
  `Event.Time`, `Note.Key`, `Note.Vel`, `Note.Dur` and `Control.Val` are written.
  Observed kinds: `NOTE`, `CONTROL`, `WHEEL`, `CHANAFT`; `KEYAFT` and `PATCH`
  are addressable through the filter API though no script branches on them.
- **Arithmetic is integer** — `/` truncates, which is why every percentage in the
  shipped scripts is `(* x pct)` followed by `(/ … 100)`. `++ -- += -= *= /=`
  return the new value, so they nest inside an expression.
- **Reporting is the weak point.** The only outputs are `message` (status line)
  and `pause` (modal), and **no shipped script writes a file**. So a note list
  cannot come back as text: a string accumulated across the per-event walk does
  not survive it — measured, the count arrived and the data did not.

#### The trap that silently corrupts output

`insert` **resets the in-flight event's fields**. `HARMONYZ.CAL` says so in a
comment: *"insertion reset Event.Time during the building of the same chord."*
Any field read after the first insert is not the value that was there before it,
so a second and third insert land at the wrong time — with no error, just
misplaced notes. Every generated script copies `Event.Time`/`Chan` and
`Note.Key`/`Vel`/`Dur` into variables *before* its first insert, and a test
asserts that ordering (`test/cal-script.test.mjs`).

Two smaller ones: durations are 16-bit and wrap at 65535 (recorded in
`STRUM-IT.CAL`), and `pause`/`getInt` are modal, so no generated script prompts.

#### Reading notes back

Three options, in order of preference, and the reasons are not symmetric:

1. **Export and parse** — `0xA659` then `cw_read_midi_file`. No side effect,
   already verified, and it returns every field of every note. This is the
   answer for reading note data.
2. **`queryNotes`** — encodes a fixed-format summary into the track name, which
   is readable from an export. It works, but it **renames the track**, so
   `cw_cal_run` refuses it without `allowRename: true`.
3. **Returning a note list as text from CAL** — measured to fail, and recorded
   as such rather than left as an implied possibility.

#### Two operational notes about running CAL

**A run leaves a file behind.** `cw_cal_run` writes `MCP-<program>.CAL` into the
real CAL folder — the same folder that holds the 37 shipped scripts. The name is
derived from the program, so a re-run with the same parameters overwrites rather
than accumulating, and identical content is detected and skipped
(`changed: false`). It still lands among the stock scripts, so anything listing
that folder will show it; delete it when done with `removeScript` or by hand.

**The dialog's filename field index is not stable.** Measured twice on the same
dialog: the `文件名(N):` textfield was element **33** in one observation and
**32** in the next, because a shell control appears or disappears while the
folder list loads. The `打开(O)` button held at 26 both times. So the plan tells
a runtime to resolve the textfield **by property** — title `文件名(N):`, kind
`textfield`, with a set-value action — rather than by the number, and a test
pins that instruction. Trusting the index would fail intermittently, which is
worse than failing outright.

### The gaps the paywall really does hold

Three of the four things this section used to list turned out **not** to be
gated, and the reasoning that put them here was wrong in a way worth recording,
because it was wrong twice over.

The original argument was: every candidate command for these operations exists
in the index with **no `CMD_ID`**, therefore it is not on the menu and cannot be
posted. Both halves of that were unsound:

- **The premise about `CMD_ID` was a misgeneralisation.** The index has 481 rows
  with `ACTION_TYPE_ID = 1` (Execute Command), and **all 481 carry a real
  `CMD_ID` that matches the live menu exactly** — verified against ids this
  adapter already posts (`0x82A6` insert MIDI track, `0x806A` run CAL, `0x804C`
  select all, `0xE101` open…). What produced the "index ids are not WM_COMMAND
  ids" warning was a different set of rows: the view-menu mirrors
  (`音轨视图->音轨->…`, `控制台视图->…`) are `ACTION_TYPE 6/7/8` with
  `CMD_ID = 0` and the real id in `ACTION_ID`. Posting their `CMD_ID` posts 0.
  The top-level rows do not have that problem.
- **The conclusion ignored CAL entirely.** Mute/solo/arm have postable ids that
  the adapter itself already listed as working in `commands.js`.

So the list shrinks to one entry, and this is what it is now:

- **Plugin insertion.** No indexed command inserts a plugin into a track's FX
  bin; `IncrementPluginPreset` / `DecrementPluginPreset` have no id. CakeScript's
  `Plugins:InsertAt` is the only in-process route. Two alternatives exist and
  neither is a scripting path: a **control-surface plugin** (the interface is
  real — `IControlSurface`/`2`/`3` in `D:\CAKEWALK\Shared Surfaces\GenericSurface.dll`,
  discovered through `HKCR\CakewalkControlSurfaces` — note that this is *not*
  `HKLM\SOFTWARE\Classes\CakewalkControlSurfaces`, which is empty; an earlier
  revision of this file gave the wrong path and a round of work was built on it,
  see **The control-surface bridge** below), or authoring a `.cwx` track
  template, which is the same binary container as `.cwp`.

### The control-surface bridge: what was built, and what it proved

This is worth reading in full, because the outcome is a **negative result** and
the negative result is the useful part. The surface plugin was expected to be the
key that unlocked mute, solo, record-arm, routing, patch and the FX bin on a free
licence. It is not, and the reason is now measured rather than assumed.

**What works, verified end to end:**

| Step | Result |
|---|---|
| Find SONAR's real discovery key | **`HKCR\CakewalkControlSurfaces\{CLSID}`** with a `Description` value. Five shipped GUIDs live there; nothing reads `HKLM\SOFTWARE\Classes\...` |
| Register a sixth entry | **works, no elevation** — writing through `HKCR` lands in `HKCU\SOFTWARE\Classes`, part of the merged view SONAR reads |
| Build a COM object of the right shape | **works** — 44-slot vtable (`IUnknown` 3 + `IDispatch` 4 + 9 + 10 + 18); `DllGetClassObject`, `CreateInstance` and all five `QueryInterface` calls succeed |
| Survive the deepest slot | **works** — slot 43 (`OnContextSwitch`), which is what a short vtable gets wrong |
| Appear in the picker | **works** — `Cakewalk MCP Surface Bridge` appears in 参数设置 > MIDI > 控制界面 alongside the five shipped surfaces |
| Get instantiated by SONAR | **works** — `Connect()` is called, and `RefreshSurface()` ticks at the configured 75 ms (158 calls in ~13 s) |

**Why this adapter no longer uses the surface (the decision and its evidence).**

The surface must be re-added once per SONAR launch, and that is now understood at
function level rather than by observation:

* `Sonar.exe` exports `CCtrlSurface::PersistSurfaces` — the function that
  **writes** `ctrlsurface.dat` — and contains **no** `LoadSurfaces`,
  `RestoreSurfaces` or `InitSurfaces` symbol anywhere. It persists the list and
  never reads it back at startup.
* Measured consequence: `ctrlsurface.dat` held the bridge's CLSID (written
  00:09), SONAR started at 00:16, and the resulting process module list did
  **not** contain `cw_surface.dll`. The file listed the bridge while the new
  process had never loaded it.

So the surface exists only between "user presses 确定" and "SONAR exits". It can
be re-added by automation — that walkthrough is below and every step in it is
reachable, because these dialogs are MFC and expose accessibility (unlike the
JUCE ones) — but doing so **requires a computer-use runtime driving SONAR's
foreground UI after every launch**, which is exactly what a one-click deployment
must not depend on. It also cannot be fixed from outside without patching the
host, which this project does not do.

**Nothing needs it any more.** Exactly one tool (`cw_surface_set`) required it to
write, and every one of those writes now has a file-based path: volume and pan
through CC7/CC10 baked into an imported `.mid` (verified end to end), mute /
rename / channel+port through CAL, and mute/solo/record-arm through a real click
on the track strip. The eight `cw_surface_*` tools are hidden unless
`CAKEWALK_MCP_SURFACE=1` is set, and `install.ps1` leaves the DLL alone unless
`-WithSurface` is passed.

The scripted walkthrough below is kept because it is the measurement record, and
because it is what makes `-WithSurface` usable on a session where you want the
diagnostics:

```text
cw_close_overlays                     PaywallWindow / Quick Start must go first,
                                      or the menu is inert
cw_run_command 0x882D                 编辑 > 参数设置
click the MIDI tree row               expands it
click the 控制界面 row
click the second header button        the 'a' button beside 已连接的控制器/界面
ComboBox 控制器/界面(C)                setValue "Cakewalk MCP Surface Bridge"
确定, then 确定                        commits and loads the plugin
```

No project needs to be open — verified by doing exactly this on a session with no
document. The dialog's input-port combo only lists MIDI devices that are *enabled*
in 参数设置 > MIDI > 设备, which is why setting it to a loopback port silently
fails until that device is enabled first.

**What the first sweep showed, and why its conclusion was wrong:**

```text
Connect: pUnknown=0000000008042F60 hwndApp=0000000000020E60
QI IDispatch -> 0x80004002          (E_NOINTERFACE)
probe IControlSurface  -> 0x80004002
probe IControlSurface2 -> 0x80004002
probe IControlSurface3 -> 0x80004002
```

For a while this was read as "the host object implements `IUnknown` and nothing
else", and that reading was **wrong in a way worth recording**: every `E_NOINTERFACE`
above is evidence about *the IIDs I guessed*, not about *the object*. A
QueryInterface failure only ever means "not this one", and four misses were
mistaken for a property of the host. The conclusion drawn from it — that
`SetTargetParam` was unreachable — was therefore premature.

**What the object actually is (measured, and it was recoverable all along)**

The way through was static analysis of `Sonar.exe`, not more guessing:

1. The log file gave **absolute** addresses, and the module base made the vtable
   RVA exact: `0x1433505D8 - 0x140000000 = 0x33505D8`.
2. On disk that RVA lands in `.rdata`, and `[vtable-8]` is an MSVC
   `RTTICompleteObjectLocator`. Following it to the TypeDescriptor gave the
   **class name: `.?AVCCtrlSurface@@`**.
3. Its `ClassHierarchyDescriptor` listed the bases — and they identify the
   object's role:
   `CUnknown`, `INonDelegatingUnknown`, `CBaseObject`,
   **`CMidiInputMonitor::CObserver`**, `CCtrlSurfaceBase`.
   It is a MIDI-input observer, i.e. the object that feeds MIDI to a surface.
4. Disassembling its **slot 0** showed it *is* `QueryInterface` — the code does
   `mov rax,[rdx]` and compares against IID pointers. That also explains the
   crash of the earlier blind probe: passing `(1, 2)` made the function
   dereference `1` as an IID.
5. The three IID addresses it compares against were extracted from that
   disassembly, and **all three now return `S_OK`**:

```text
probe HOST_IFACE_1 -> 0x00000000   {ED0C14F0-40F3-4459-813C-CB5B5A5E4958}
probe HOST_IFACE_2 -> 0x00000000   {85F8BB17-75F8-497F-8319-EF33A632C380}
probe HOST_IFACE_3 -> 0x00000000   {55507DE1-C037-4682-A4EC-65B1D2E86B53}
accepted iface 0: vtable=0x14340ECF8 slots=5
accepted iface 1: vtable=0x14340EC98 slots=6
accepted iface 2: vtable=0x14340EC28 slots=8
```

So the host object **does** expose usable interfaces. The plugin now captures
each accepted interface and its vtable, and `cw_surface_diag` / `op:"probe"`
report them. Nothing about the earlier four `E_NOINTERFACE` lines was wrong as a
measurement; only the generalisation from them was.

**The question is now closed by disassembly — and the answer is that these methods were never there**

Following the host object down to its vtable settled it, and closed the search
rather than leaving it open. The full analysis is in
[`native/surface/ANALYSIS.md`](native/surface/ANALYSIS.md); the finding is:

**`CCtrlSurface` has exactly 13 slots, and they line up with `IControlSurface`:**

```
slot  0  QueryInterface              compares IIDs (mov rax,[rdx])
slot  1  AddRef                      lock inc [rcx+0x10]
slot  2  Release                     lock xadd [rcx+0x10]
slot  3  GetStatusText
slot  4  MidiInShortMsg
slot  5  MidiInLongMsg
slot  6  Connect
slot  7  Disconnect
slot  8  RefreshSurface
slot  9  GetNoEchoMask
slot 10  GetVersion
slot 11  GetNoEchoStatusMessages
slot 12  (IControlSurface2 begins)
```

So the object SONAR hands to `Connect` **is itself an `IControlSurface`
implementation with 13 slots** — not the 44-slot `IControlSurface3`, and not the
59-slot `CSonarMixer`. **`SetBaseTrack` and `SetTargetParam` are not in it at
all.** No amount of guessing its IIDs could have found them, which is exactly
what the four earlier `E_NOINTERFACE` results were really saying.

Disassembling the shipped `GenericSurface.dll` then showed the interface runs in
the **opposite direction from what the plan assumed**:

| Method | Shipped implementation | Meaning |
|---|---|---|
| `SetTargetParam` | reads `this+0xF0` — its OWN state | SONAR notifies the **surface** that a value changed, so it can move its fader |
| `SetParamMidiMsg` | `mov eax,0x80004001; ret` = **`E_NOTIMPL`** | the surface does **not** declare a MIDI mapping |
| `GetTargetParam` | reads `this+0xF0` | the host asks the surface what it is displaying |

The surface interface is **host → surface notification**. A surface does not push
values into SONAR through it. `cw_surface_set` still refuses, and now for a
reason that is established rather than unknown.

**What does work, and it is now exposed as a tool: MIDI**

A surface's channel back into SONAR is MIDI, and it needs exactly one thing — the
surface must be assigned the right **input port**. The default is the audio
interface, which is why the first attempts saw nothing.

Measured, after setting 输入端口 to the loopback port:

```
before: 0
after : 11
  0xB0 d1=7  d2=20     CC7 volume
  0xB0 d1=7  d2=35
  ...
  0xB0 d1=10 d2=64     CC10 pan
  0xB0 d1=1  d2=10     CC1 modulation
  0x90 d1=0  d2=100    Note On
```

**11 of 11 messages arrived**, with status, data bytes and arrival tick. This is
a genuine, verified two-way link between a process inside SONAR and the adapter,
and it is available as **`cw_surface_midi_in`**.

What is still missing is the *interpretation*: mapping "CC7 on channel 1" to
"set volume on base track + N" needs mixer access, which lives in
`CGenericSurfaceStrip` (12 slots) behind an indexed global table — one of its
failure paths returns `0x8002000B` = `DISP_E_BADINDEX`, an IDispatch error code,
which is evidence the lookup is by index rather than by name.

Closing that needs the `SURFACEFRAMELib` type library or more disassembly of the
strip's mixer path. The type library is confirmed unavailable: it is not on disk,
not registered, and **no DLL in the set will load with `LoadTypeLibEx`** — all
return `0x80029C4A` (`TYPE_E_CANTLOADLIBRARY`) and `LoadRegTypeLib` returns
`0x8002801D` (`TYPE_E_LIBNOTREGISTERED`). It was a compile-time `#import` only.

**The earlier probing attempt, and why calling was abandoned**

Before accepting the above, three more attempts were made to identify the host
object, and the last one crashed SONAR. All of it is recorded because the
conclusion is stronger than "we did not find it":

1. **Recover the interface from the binary.** `GenericSurface.dll` does contain
   the method-name strings — `GetTargetParam`, `SetTargetParam`, `SetBaseTrack`,
   `GetTrackCount`, `SetBankWidth` — but they are *its own* vtable entries, the
   ones SONAR calls on the surface. They name the parameter `mixerParam` and
   `dwParamNum` from the callee side. Nothing there reveals what SONAR passes
   *in*, and the referenced typelib (`SURFACEFRAMELib`) has no resource table in
   the DLL and no `.tlb` anywhere on disk.

2. **Recover the class from RTTI.** The vtable was attributed to `Sonar.exe` and
   the first twelve slots all resolve into it, so the object is a real C++
   class in the host. But the MSVC `RTTICompleteObjectLocator` read back empty,
   and Sonar.exe is stripped — 7 symbols — so the class name could not be
   recovered that way.

3. **Identify the setter by behaviour.** Call each vtable slot and see which one
   moves a track's mute state; no name needed. This was implemented and run
   twice:

   - **First run deadlocked the bridge.** Calling slot 0 from the bridge's own
     worker thread never returned, and every later request timed out. SONAR was
     fine — project intact, menu working, document not even modified — but the
     channel was dead until restart.
   - **Second run isolated each call on its own thread with a timeout**, which
     fixed that exactly as intended: nine slots reported "did not return"
     without touching the bridge, three returned values consistent with an
     `IUnknown` prefix (slot 1 = 6, slot 2 = 5 — reference counts; slot 3 = a
     heap pointer), and the bridge answered `ping` afterwards.

     **And SONAR then raised its own crash dialog: `C0000005`, access
     violation**, dumped to `MiniDumps\Untitled_10162026_020341.dmp`.

   Isolation protected the bridge, not the host. The harmful call happened
   inside SONAR on a thread that could not be recalled. Recovery was offered and
   declined, so no project file was written.

**The general lesson, which is the real result here:** an unknown C++ interface
cannot be discovered by calling it. Every guard available from the caller —
memory protection, thread isolation, timeouts — protects the caller and never
the callee. A wrong-but-executable slot runs at full privilege inside the host,
and this host crashes on the wrong guess rather than returning an error. All of
that probing code has been removed rather than left switchable: an operation
that can silently kill the host is worse than no operation.

**What was kept, and why it is still worth having:**

- `cw_surface_status` / `cw_surface_diag` / `cw_surface_params` / `cw_surface_help`
  — the status separates `not-installed` from `needs-user-setup` from `ready`, and
  the diagnostics are what produced the measurement above. Anyone re-attempting
  this on a future build should start from `cw_surface_diag`.
- The plugin source and build. If a later SONAR hands over a richer object, the
  sweep shows it immediately and the write path can be completed.
- A JSON-escaping fix in the DLL, found because the first error message contained
  a bare `"` and the client reported "unparseable JSON" instead of the error. A
  protocol that mangles its own error messages is worse than one that has none;
  there is now a regression test on both sides.

**Two by-products that matter more than the negative result:**

1. **`RefreshSurface` is a real, configurable heartbeat** — 75 ms default, set in
   ‎参数设置 > MIDI > 控制界面 → 刷新频率(毫秒). A surface that only needed to
   *read* or *tick* could use it.
2. **The accessibility path already covers what the surface was meant to give.**
   The track strips expose `手动静音`, `独奏`, `录制`, `输出`, `输入`, `音色`,
   `音色库` and `MIDI 通道` as named, settable elements — see **Reading tracks
   works; writing needs a different transport**. The surface was an attempt to
   reach these *without* a UI dependency, and it failed; the UI path is the one
   that works.

**The operational cost, stated plainly:** a registered surface is not remembered
for free. It appears in the picker persistently, but the DLL only loads once the
surface has been added in Preferences for that session, so a fresh SONAR has no
bridge listening. `cw_surface_status` reports that as `not-installed`, and
`native/surface/install.ps1` is how it comes back.


#### What was wrong about rename, mute, solo and arm

- **Track rename is not gated** — CAL has `(TrackName "string" idx)`, and it was
  measured end to end: `(TrackName "MCP-VERIFY" 2)` ran through `0x806A` and the
  exported `.mid` came back with that track renamed. The index genuinely has no
  rename command, which is what made this look impossible; CAL has one anyway,
  because CAL is a language the index does not describe.
- **Mute is not gated** — CAL has `(TrackActive TRUE|FALSE idx)`. The semantics
  are pinned by a shipped comment rather than assumed: `Split Channel to
  Tracks.cal:40` reads `; Un-mute the track` directly above
  `(TrackActive TRUE nTrk)`, so `TRUE` is audible and `FALSE` is muted.
- **Mute, solo and arm also have postable menu commands** after all:
  `MuteSelectedTracks` `0x80E1` (32993), `SoloAllSelectedTracks` `0x809F` (32927),
  `ArmSelectedTracks` `0x80E2` (32994), plus the `Toggle*AllTracks` family at
  `0x8202`–`0x8204`, two of which `commands.js` already records as working.
  They act on the **selection**, so the precondition is a selected track, not a
  dialog. (They were never actually id-less: the index row carries the id.)
- **CAL routing** — `(TrackChannel chan idx)` and `(TrackPort port idx)` are
  proven in the shipped scripts.

What CAL still does **not** have, as a clean negative from grepping every shipped
script: `TrackSolo`, `TrackArm`, `TrackVolume`, `TrackPan`, `TrackPatch`,
`TrackBank`, `TrackOutput`, `TrackInput` — zero hits each. So solo and record-arm
are reachable only through the menu commands above, and volume/pan through MIDI
or the COM surface interface.

#### The one structural rule that cost two failed runs

A **top-level expression in a CAL file is the per-event body slot**, not a
statement. A track builtin written loose there fails with
`CAL Error 016: 无效的事件信息或主体表达式` naming the builtin. The shape that
works — and it is what every generated track program now emits — is:

```cal
(do           ; prolog: declarations
  (include "need20.cal")
  (int trk 2)
)
NIL           ; body: the event walk, empty here — REQUIRED
(TrackName "MCP-VERIFY" trk)   ; epilog: runs once
(pause "...")
```

Wrapping the prolog and the track call in a **single** `(do …)` fails too,
because then the call is no longer in the epilog position. Both mistakes were
made and measured; a test now pins the shape.

#### The two earlier entries that were withdrawn

**Note add / delete / read** was on this list because every note command in the
index is a piano-roll *display* toggle with `CMD_ID = 0`. The reasoning was sound
and the conclusion was still wrong: **CAL is a note-level API the index does not
describe as one.** Its menu entry is filed under 处理 as a macro runner, and
nothing in the index hints that the language behind it writes `Note.Key`. It was
found by reading the 37 shipped `.CAL` scripts, not by mining commands.

**Track rename, mute and arm** were on this list for the same structural reason —
looked for in the index, not found there, declared absent. Rename genuinely has
no command; CAL provides it anyway. Mute and arm turned out to *have* commands,
and the search that missed them was reading the wrong column of the index.

So the honest summary, after measuring both layers: **transformation** of
existing notes is available through the edit dialogs (nine operations, five
verified end to end); **creation, deletion and reading** through CAL (four
operations, four verified); and **track rename, mute, routing, solo and arm**
through CAL builtins and selection-based menu commands. What the paywall
actually holds, as far as this investigation reached, is **plugin insertion** —
and even that has a non-scripting alternative in the control-surface COM
interface.

### Routes to CakeScript that were tried and do not work

Recorded so nobody spends the time again. Each was tested on 2026.10, and the
negative result is the finding:

- **Command-line switches.** The binary contains the literal strings `/cakeScript`
  and `/script` (one occurrence each), which looked like an unattended entry
  point. They are not. Five invocation forms were tried against the real script
  engine — `/cakeScript <file>`, `/script <file>`, `-script <file>`,
  `/run <file>`, and a bare `<file>` argument — each in a fresh process with a
  15 s window, and the script was written to make a file as proof of execution
  (both via Lua `io.open` and `cakeapp.filesystem`, so either path would count).
  **No form executed the script.** SONAR starts to its normal frame and ignores
  the argument, so those strings belong to something other than argument parsing.
- **File association.** `.lua` has no `assoc`/`ftype` entry on this machine, so
  there is no shell verb to invoke and double-clicking a script is not wired up.
- **Driving the dialog controls with `WM_SETTEXT`.** This looked promising and
  half worked. UIA cannot see the dialog from `RootElement` (it is a child of
  the SONAR frame, not a desktop top-level), but it *can* be bound — enumerate
  the process's `#32770` windows, then `AutomationElement.FromHandle`. That
  yields the **real HWND of every control**:
  `331254|Edit` (the 数量 field), `2624150|Button|确定`, `7210576|Button|取消`,
  and `723106|CC:SpinCtrl`. The catch is what those controls are: SONAR's number
  fields are **`CC:SpinCtrl`**, a custom control, and the `Edit` beside it is a
  shadow. `WM_SETTEXT "7"` on that Edit reads straight back as `'7'` — and a
  fresh `GetWindowText` on the same handle returns **empty** again, because the
  value the dialog uses lives in the SpinCtrl, not in the edit's text buffer.
  This is the same shape as the track strips: the control accepts the write and
  ignores it. `WM_SETTEXT` is therefore not a way in for these fields.
- **`XCDCakeServices`.** Appears once as a string in the binary, so the helper
  process the original plan went looking for is *named* there — but no process
  or window of that name is ever created, matching the earlier finding that the
  XCD/LLM surface is not running on this build.

What remains as the working path is the one already proven: **post the menu
command, then drive the resulting MFC dialog with an accessibility runtime that
can set values on real controls** — which is what `cw_quantize_dialog` and
`cw_note_edit_help` describe, and what computer-use does when it calls
`setValue` on element 25 of the 移调 dialog.

### Working around the missing T1

1. **MIDI for changes.** `cw_midi_*` sends are verified end to end, and the
   receive side is enabled and confirmed through TTSSEQ.INI. This is the path
   that actually alters a project on this build.
2. **Accessibility for reads.** With a project open, `cw_track_controls` gives
   the exact element naming for volume, pan, routing and the mute/solo/arm
   flags. Reading is accurate; writing is a no-op (see the section above).
3. **Menu commands for navigation.** `cw_run_command` opens views, inserts
   tracks and drives transport once a document exists.
4. **A build that restores the Assistant panel** brings T1 back with no changes
   here. It was present in 32.08.0.040.

## How this compares to other DAW/tool MCP surfaces

Measured 2026-10-15 against two mature references available on this machine: the
**ACE Studio MCP** (63 tools, enumerated live from `ace-mcp-server.exe`) and the
**After Effects adapter** (36 tools). The point of the comparison was to find
out whether this one is missing something a user would notice, rather than
assuming its coverage was adequate.

### The honest summary

**Coverage is the thinnest of the three; the honesty layer is the strongest.**

That is not a consolation prize. This host hides almost everything — the broad
scripting API is paywalled, the track strips are drawn rather than exposed,
and most commands change state with no window to diff. The other two hosts
expose real APIs, so their tools can simply return values. Here, a tool that
cannot confirm its own effect is the default case, which is why so much of this
adapter is about *stating what could and could not be established*.

### What the comparison found missing, and what was done about it

| Gap | Reference | Verdict |
|---|---|---|
| **Undo / redo / history** | ACE `history_edit` | **Closed** — `cw_undo`, `cw_redo`, `cw_history`, `cw_history_help`. Measured: rewinding to an older stack entry took a project from 16 notes to 8. |
| **Clip CRUD** | ACE `clip_edit` (18 verbs) | Partial — split and merge exist as dialogs (`cw_edit`); create/delete/move/resize have no surface on this build. |
| **Plugin insert → params → presets → editor UI** | ACE (the richest surface of the three) | **Blocked** — no insertion path exists; `cw_plugin_insert_recipe` records why. The only non-scripting routes are a control-surface COM plugin or a `.cwx` template. |
| **Automation envelopes, sends/buses** | ACE `midiparam_*`, `vocalparam_*` | **Blocked** — drawn, not writable, and CAL has no envelope builtin. |
| **Async job handles** | ACE `job_*` | Open — this adapter blocks and pushes budget management onto the caller (`cw_add_song_tracks(budgetMs)`). A server-side wrapper would close it cheaply. |
| **Tick/time/bar conversion** | ACE `convert_edit` | Open — pure arithmetic, no host involvement needed. |
| **One docs index** | ACE `get_docs` | Partial — this adapter has 12 measured help tools; discoverability is weaker than one index, correctness is stronger. |

### Where this adapter is ahead

- **`cw_run_command_classified`** returns `confirmed` / `did-nothing` /
  `unconfirmed` with the evidence class behind it. Neither reference does this —
  both report success from "the call returned", which on a drawn UI is a guess.
- **`cw_no_effect_causes`** — the three-cause taxonomy (drawn-not-exposed,
  precondition-missing, gated-by-licence) came from being wrong twice, and it is
  the cheapest guard against concluding "broken" when it is a toggle.
- **`cw_verify_commands`** — command ids change between builds (32.08 vs 32.10),
  so the ids are read from the live menu and can be re-measured.
- **The `confirm: '<command-name>'` guard** — a destructive tool refuses a bare
  boolean, so the caller must name what it destroys.

### Two design ideas worth copying from ACE

1. **Pair read/edit per domain** rather than a flat tool list. The split encodes a
   safety boundary and makes the surface discoverable one level down.
2. **Return a job handle for slow work.** This adapter already knows which
   operations are slow — it budgets them — and used to make the caller wait.
   `cw_job` / `cw_jobs` / `cw_job_abandon` / `cw_job_clear` now exist for it.

### What is deliberately not attempted

Plugin insertion and automation envelopes. Each was investigated and the negative
result is recorded, so nobody spends the time again.

Plugin insertion in particular now has a **closed** route rather than an
untried one. The control-surface COM interface was built, registered, loaded and
driven end to end — and the host object SONAR passes to `Connect` implements
`IUnknown` and nothing else, so `SetTargetParam` has no reachable vtable slot.
Details and the raw `QueryInterface` results are in
**The control-surface bridge**. The remaining non-scripting route is authoring a
`.cwx` track template, the same binary container as `.cwp`.


## Tools

| Tool | Transport | What it does |
|---|---|---|
| `cw_doctor` | — | Health check across all five transports with verdicts and remedies — run first after a SONAR upgrade |
| `cw_status` | — | Host, version, transports, real-time MIDI state, recommended path |
| `cw_save_state` | — | Whether the open project has unsaved changes |
| `cw_project` | T2 | newProject / open / save / saveAs / close / exportAudio / importMidi / revert |
| `cw_file_dialog` | — | How to drive the file dialog, and why it IS scriptable |
| `cw_transport_command` | T2 | play / stop / record / loop / metronome / tempo & meter views |
| `cw_timing` | — | How to set and read tempo and time signature |
| `cw_navigate` | T2 | Selection, now-time movement, and markers |
| `cw_edit` | T2 | quantize / transpose / split / merge / gain / normalize / reverse / fade |
| `cw_edit_help` | — | The editing layer, its preconditions and its dialogs |
| `cw_note_edit_help` | — | How notes are edited: the dialog route, the export check, and the two mistakes behind it |
| `cw_quantize_plan` | — | The exact dialog writes for a given quantize, and how to prove it landed |
| `cw_check_quantize` | — | Judge a quantize from two tick lists — pure arithmetic, no SONAR needed |
| `cw_quantize_dialog` | — | The 量化 dialog as measured: fields, element kinds, traps |
| `cw_cal_help` | — | The CAL language: fields, operators, builtins, the run procedure, and the traps |
| `cw_cal_plan` | — | The exact plan for a CAL run — source, dialog write, verification. Pure |
| `cw_cal_run` | T2 | Write a CAL program, post 0x806A, and report the dialog steps. **No licence needed** — notes *and* track properties |
| `cw_cal_cleanup` | — | Delete the CAL scripts `cw_cal_run` wrote, and their .bak copies |
| `cw_undo` | T2 | Rewind the last operation. Silent — it cannot be confirmed from the screen |
| `cw_redo` | T2 | Reapply the last undone operation |
| `cw_history` | T2 | Open the undo stack (0x8044) and report how to read and rewind it |
| `cw_history_help` | — | How undo works here, and the trap in verifying a rewind |
| `cw_convert` | — | Convert between ticks, bar:beat:tick and seconds. Pure arithmetic |
| `cw_convert_help` | — | The time units, the 1-based/0-based trap, and what conversions cannot do |
| `cw_surface_status` | socket | **Opt-in** (`CAKEWALK_MCP_SURFACE=1`). Is the plugin loaded, has SONAR called Connect, what is still needed |
| `cw_surface_diag` | socket | **Opt-in.** The plugin's log, counters, and the interface sweep that established what the host object is |
| `cw_surface_params` | socket | **Opt-in.** The parameter vocabulary the plugin accepts, with each kind |
| `cw_surface_set` | socket | **Opt-in.** Set a mixer parameter. **Refuses on this build** — the host object has no `IDispatch`; use the .mid / CAL / click paths instead |
| `cw_surface_midi_in` | socket | **Opt-in.** MIDI that SONAR forwarded to the surface, decoded — needs the input port assigned |
| `cw_surface_help` | — | **Opt-in.** How the bridge works, how SONAR discovers a surface, and what it cannot do |
| `cw_job` | — | Read one background job: state, elapsed, progress trail, result or error |
| `cw_jobs` | — | List recent jobs, newest first, without payloads |
| `cw_job_abandon` | — | Discard a job's result. Does **not** stop work already posted to SONAR |
| `cw_job_clear` | — | Forget finished jobs; running ones are kept |
| `cw_job_help` | — | Why background jobs exist, and the one thing the API cannot do |
| `cw_no_effect_causes` | — | Why a command can report nothing happened — three causes |
| `cw_markers` | — | The marker dialog (writable), its commands, and the readback path |
| `cw_command_evidence` | — | Which commands are confirmed, which are unconfirmed and why |
| `cw_run_command_classified` | T2 | Run a command and report what could and could not be established |
| `cw_command_support` | — | Which commands `WM_COMMAND` actually drives, measured, plus the UI recipe |
| `cw_verify_commands` | — | Re-measure command ids against the running SONAR after an update |
| `cw_ui_recipe` | — | How to drive the UI, what is unreachable, and how to recover a lockup |
| `cw_list_commands` | T2 | `source="live"` lists postable ids; `source="index"` searches SONAR's command index |
| `cw_run_command` | T2 | Run a menu command by id; reports whether the window list changed |
| `cw_list_overlays` | — | Modal panels currently blocking menu commands |
| `cw_close_overlays` | — | Close those panels |
| `cw_midi_status` | T4 | Live MIDI ports, which is selected, whether SONAR is tuned to it |
| `cw_set_pan` / `cw_set_volume` | T4 | Set pan (CC10) / volume (CC7) on a channel |
| `cw_apply_mix` | T4 | Pan and volume for several channels in one round trip |
| `cw_mixer_targets` / `cw_mixer_support` | — | What a live mixer message can affect, and what is measurable |
| `cw_write_midi_file` | file | Compose notes and CCs into a format-1 .mid, with mixer values baked in |
| `cw_read_midi_file` | file | Parse a .mid — names, channels, notes, CC7/CC10 with pan spelled out |
| `cw_plugins` | — | Registered plugin counts across all three sources, categories, missing files |
| `cw_find_plugin` | — | Search 1208 plugins by name, with format (VST3/VST2/DX), kind and file presence |
| `cw_plugin_insert_recipe` | — | What plugin discovery can do and why insertion cannot be driven |
| `cw_song_instruments` | — | Instruments grouped by songwriting role |
| `cw_add_track` | T2 | Insert a track (midi / audio / bus / folder / aux) |
| `cw_add_song_tracks` | T2 | Insert the tracks a simple arrangement needs |
| `cw_insert_commands` | — | Every 插入 command with its id |
| `cw_benchmark` | — | Measure every capability, grouped by transport |
| `cw_latency` | — | Per-operation latency profile |
| `cw_midi_config` | — | SONAR's enabled MIDI ports, read from TTSSEQ.INI (verifies the receive side) |
| `cw_enable_midi_port` | — | Enable a port by writing TTSSEQ.INI — no UI needed, idempotent |
| `cw_midi_devices` | T4 | Every MIDI device Windows reports |
| `cw_midi_note` | T4 | Play one note (pitch / velocity / duration / channel) |
| `cw_midi_chord` | T4 | Play several notes at once, released together |
| `cw_midi_cc` | T4 | Control change — 7 volume, 10 pan |
| `cw_midi_send` | T4 | Batch of raw `[status, data1, data2]` messages in one round trip |
| `cw_midi_panic` | T4 | All-notes-off and reset on every channel |
| `cw_probe_state` | — | Plan for reading project state via computer-use, per topic |
| `cw_report_state` | — | Cache an observation from a computer-use agent |
| `cw_get_state` / `cw_list_state` | — | Read the observation cache, with staleness |
| `cw_surfaces` | — | Which SONAR surface carries which project fact |
| `cw_list_tracks` | T1 | All tracks in the active project |
| `cw_get_track` | T1 | One track's volume/pan/mute/solo/arm/sends/clips |
| `cw_set_track_volume` | T1 | Volume (0.0–4.0) |
| `cw_set_track_pan` | T1 | Pan (-1.0…+1.0) |
| `cw_set_track_mute` | T5 | Mute / unmute, by clicking the strip's 手动静音 button |
| `cw_set_track_solo` | T5 | Solo / unsolo, by clicking 独奏 |
| `cw_set_track_arm` | T5 | Arm / unarm for record, by clicking 录制 |
| `cw_get_track_control` | T5 | Read any strip control as SONAR shows it (音量, 声像, 输入, 输出, …) |
| `cw_set_track_name` | T5 | Rename, by editing the strip's name field (double-click + clipboard paste — handles Chinese) |
| `cw_list_track_templates` | — | The .cwx track templates on disk, with categories (184 on this machine) |
| `cw_insert_track_template` | T5 | Insert a template — instrument + FX chain + routing — and confirm the new track by name |
| `cw_get_clips` | T1 | Clips on a track |
| `cw_get_notes` | T1 | Notes from a clip (pitch/velocity/time/duration) |
| `cw_transport` | T1 | play / stop / record / pause |
| `cw_locate` | T1 | Move the now-time (Bars\|Beats) |

## The command index

SONAR keeps a SQLite database of every command, view, setting and help topic at
`%APPDATA%\Cakewalk\Sonar\cwsearch.dat`. It powers the command palette, and
`cw_list_commands source="index"` reads it: 1315 rows on this machine, each with
a label, the menu path it lives under (e.g. `处理(P)->运行 CakeScript 程序`), and
a `CMD_ID`.

**`CMD_ID` is not a `WM_COMMAND` id.** Posting one is silently dropped. The
index is useful for *finding* what a build offers and for the human-readable
menu path — not for dispatching. Only ids read from the live menu via
`GetMenuItemID` are postable, and even then only for main-frame commands.

## Which commands respond

Measured on 32.10.0.021; `cw_verify_commands` re-checks on demand and
`cw_command_support` reports the split for the current document state.

**Always work** — app-level commands the main frame owns:

| id | command | effect |
|---|---|---|
| `0x882D` | 编辑 > 参数设置 | opens Preferences |
| `0xE140` | 帮助 > 关于 Sonar | opens About |
| `0xA783` | Cakewalk 助理 | toggles the Assistant / palette panel |
| `0xA798` | 工具 > 视频引擎设置 | opens the video engine panel |
| `0x8036` | 重置 MIDI 和音频 | opens a confirmation dialog |
| `0x80B3` | 文件 > 新建 | opens the 新建工程文件 dialog |
| `0xE101` | 文件 > 打开 | opens the file dialog |

**Additional ones that respond once a project is open** — verified against a live
16-track project:

| id | command | observed |
|---|---|---|
| `0x8294` | 视图 > 音轨视图 | opens the track view |
| `0x82A6` | 插入 > MIDI 轨 | inserts a MIDI track (title gains `*`) |
| `0x82A5` | 插入 > 音频轨 | inserts an audio track |
| `0x8105` | 视图 > AI Assist | responds (membership panel on a free licence) |
| `0xA78D` | 处理 > 运行 CakeScript 程序 | responds |
| `0xA797` | 视图 > CakeScript View | responds |
| `0x8021` `0x8023` `0x8029` | 视图 > 事件列表 / 钢琴卷帘 / 控制台 | open the view |
| `0x801C` `0x801D` `0x801F` | 录制 / 播放停止 / 停止 | transport |
| `0x8202` `0x8203` | 静音 / 独奏 全部音轨 | track state |

**A caution about the verification method.** `cw_verify_commands` diffs the
window list, which cannot see a command that changes state without opening a
window. Transport, mute and solo all appear as `unchanged` **even when they
worked**. Read the blind-spot list in `lib/commands.js` before concluding a
command is dead.

## Benchmarks

`cw_benchmark` runs every capability against the live SONAR and reports each
result **with the method used to confirm it**, because a PASS from "the window
title changed" and a PASS from "the element value changed" are not equally
strong. `cw_latency` profiles the individual operations.

Current state on 32.10.0.021 with a project open — **16 of 17 pass**; the one
failure is the expected absence of the CakeScript transport:

```
read/static    pass 3   plugin inventory, plugin search, MIDI port config
read/win32     pass 4   bridge status, live menu tree, document detect, overlays
write/menu     pass 4   assistant toggle, view command, insert command, transport
write/midi     pass 4   port resolve, one note, one CC, a batch
read/config    pass 1   SONAR tuned to the cable (from TTSSEQ.INI)
transport/T1   fail 1   no XCD*/LLM* window — expected on this build
```

Latency, median over repeated runs:

| Operation | Median |
|---|---|
| MIDI: send one message | **18 ms** |
| Plugins: inventory (warm) | 30 ms |
| Bridge: menu tree | 283 ms |
| Bridge: status | 362 ms |
| Menu: post a command | 2404 ms |

Two notes on the numbers. The menu path is slow by design: `cw_run_command`
closes modal overlays first and then waits ~1.2 s to observe whether anything
opened, which is what makes `none-observed` meaningful. And the plugin inventory
was **28 s** until the read was changed from `reg query /s` (which recurses into
all 946 subkeys for their values) to the top-level query (which returns the
subkey names only) — **10 415 ms → 74 ms**. CLSIDs are now fetched per-plugin,
on demand, at ~10 ms each.

## Project layout

```
<package>\
├── package.json
├── bin\cakewalk-mcp.js        # entry point (starts the shims)
├── bridge\
│   ├── agent.js               # PowerShell user32 bridge: status, menu, runmenu, overlays, probe
│   ├── midi.js                # PowerShell winmm shim: devices, open, send, panic
│   └── loopback.js            # winmm MIDI input capture (for verifying a cable nothing holds)
├── lib\
│   ├── sonar.js               # host discovery (Sonar.exe, scripts folder)
│   ├── dispatch.js            # transport probing + the "what to use instead" errors
│   ├── menu.js                # command index + live menu + WM_COMMAND dispatch
│   ├── commands.js            # measured command support + the UI recipe
│   ├── track-ui.js            # the track-control contract, read/write split
│   ├── transport.js           # transport, tempo, meter, loop — posture over confirmation
│   ├── navigate.js            # selection, now-time, markers + the writable-dialog pattern
│   ├── edit.js                # editing/processing + the precondition that makes them work
│   ├── note-edit.js           # note-level editing: the quantize dialog and the export proof
│   ├── project.js             # document lifecycle + the destructive-command guard
│   ├── verify.js              # evidence classes: what this process can and cannot confirm
│   ├── mixer.js               # volume/pan via CC — the path that works
│   ├── midi-file.js           # read/write standard MIDI files (the data level)
│   ├── live.js                # real-time MIDI transport (port picking + musical ops)
│   ├── midi-config.js         # read/write TTSSEQ.INI — SONAR's enabled MIDI ports
│   ├── plugins.js             # plugin detection (registry + menu layout + disk)
│   ├── tracks.js              # insert tracks (menu commands + verification)
│   ├── project-state.js       # probe plans, operation recipes, observation cache
│   ├── benchmark.js           # capability measurement + latency profile
│   ├── convert.js             # ticks <-> bar:beat:tick <-> seconds, and the note-value table
│   ├── surface.js             # the control-surface bridge client (loopback TCP, JSON lines)
│   ├── jobs.js                # background job handles for the slow operations
│   ├── run.js                 # CakeScript templates over T1
│   ├── cake_templates.js      # parameterised CakeScript (Lua) programs
│   └── server.js              # MCP tool definitions (89 tools; 97 with CAKEWALK_MCP_SURFACE=1)
├── native\surface\            # the control-surface plugin (C, mingw)
│   ├── cw_surface.c           # IControlSurface3 + worker thread + loopback bridge + diagnostics
│   ├── build.cmd              # mingw gcc build (no MSVC on this machine)
│   ├── install.ps1            # regsvr32 / folder-copy install, and -Unregister
│   ├── loadprobe2.c           # off-line COM contract test: 5 IIDs, slots 10/14/26/43
│   ├── ANALYSIS.md            # the full disassembly record: CCtrlSurface's 13 slots,
│   │                          #   the 3 real IIDs, why SetTargetParam is host->surface
│   └── build\cw_surface.dll   # the built plugin
├── node_modules\              # @modelcontextprotocol/sdk + zod + ...
├── test\                      # node:test, no new dependencies
│   ├── helpers.mjs            # fixtures + shim teardown
│   ├── pure.test.mjs          # 25  maths, encodings, coordinate conversion
│   ├── midi-file.test.mjs     # 17  .mid write/read round trips
│   ├── parsers.test.mjs       # 24  registry, INI, menu layout, document title
│   ├── navigate.test.mjs      # 21  selection/marker records and their evidence classes
│   ├── edit.test.mjs          # 26  the editing layer and the false-positive fixes
│   ├── note-edit.test.mjs     # 50  quantize arithmetic vs a real measured run
│   ├── cal-script.test.mjs    # CAL generators, the structural rule, and the write path
│   ├── history.test.mjs       # undo/redo records and the rewind-verification trap
│   ├── convert.test.mjs       # tick/bar/second conversions and their boundaries
│   ├── surface.test.mjs       # the bridge protocol: framing, encoding, error
│   │                          #   classification, and MIDI-in decoding
│   ├── jobs.test.mjs          # job lifecycle, late results, bounded progress trail
│   ├── capability.test.mjs    # 23  the guards and the honest-reporting layers   [--full]
│   ├── integration.test.mjs   # 24  MCP protocol, tool schemas, bridge liveness  [--full]
│   └── blackbox.test.mjs      # 25  the whole adapter through MCP only, no internal imports [--full]
├── run-tests.mjs              # one command, one number; --full for the slow tier
├── mix.mjs                    # compose the song with its mix baked in
├── song.mjs                   # perform it over the live MIDI cable
└── README.md
```

## Tests

**Two tiers, no new dependencies** (`node:test`).

```bash
node run-tests.mjs            # fast tier — 0.6s, no processes
node run-tests.mjs --full     # everything — several minutes
```

**The counts are not written here on purpose.** `node run-tests.mjs` prints a
per-suite block at the end of every run, and that block is the only source:

```
  per-suite (runner counts):
    edit.test.mjs                25
    midi-file.test.mjs           17
    ...
```

An earlier version of this file carried the numbers by hand, and an adversarial
audit caught it **three separate times** — the headline, the per-suite table and
the directory tree each disagreed with the others and with reality, because they
were written at different moments while the suite was still growing. The audit
also showed the "rule" I invented to reconcile them was itself wrong: I claimed
per-suite rows used top-level `test()` counts, but the gap between that and the
runner's figure varies per file (it depends on how many `describe` blocks a suite
has), so the rows could not be summed to the total. Both problems have one fix —
stop transcribing, start copying from the run.

The tier split exists because the full run was **7m35s**, and almost all of it
was waiting on processes. A suite that takes seven minutes to answer "did that
edit break anything" stops being run. The tier is an explicit file list, not a
timing heuristic — and the runner now *refuses to start* if a listed suite no
longer exists, because renaming a slow suite used to promote it silently into the
fast tier.

That split also exposed something the numbers had been hiding. Three suites
called themselves white-box and took **25s, 28s and 46s**, because each reached
the PowerShell bridge from inside a unit test. Once the pure parts were extracted
(`classifyTitle`, `classifyEditResult`, `describeNavigateResult`) they run in
**~200 ms each** — the `edit` suite went from **46,316 ms to 83 ms**. The
behaviour did not change; only which layer owned each assertion.

Reproduce it, per suite, in a shell:

```bash
for f in pure midi-file parsers navigate edit note-edit; do
  t0=$(date +%s%N); node --test test/$f.test.mjs >/dev/null 2>&1; t1=$(date +%s%N)
  printf "%-12s %6d ms\n" "$f" $(( (t1-t0)/1000000 ))
done
# pure 200 · midi-file 229 · parsers 277 · navigate 199 · edit 199 · note-edit 210
```

An adversarial audit flagged the original claim as **unverifiable** — there was no
artifact anywhere in the repo backing "46,316 ms", and no git history to check it
against. That is a fair criticism of how the number was recorded, and the command
above is the fix: the measurement is now a one-liner anyone can re-run rather than
a figure copied out of a session. The old baseline cannot be re-measured (the code
that was slow no longer exists in that form), so it is quoted as what it was: a
single observation, not a standing guarantee.

### Fast tier — the logic, importing the modules

| Suite | Tests | What it protects |
|---|---|---|
| pure | 25 | arithmetic with a plausible-but-wrong alternative — a 0-based channel, a 64-centred pan, a bit-shift off-by-one |
| midi-file | 17 | the writer and reader are independent implementations of one spec, so a bad byte surfaces as a wrong note, channel or position |
| parsers | 24 | external formats that cannot be regenerated — a `reg query` dump, an INI, an XML layout |
| navigate | 21 | selection/marker records and their evidence classes |
| edit | 26 | the editing layer, the selection-honesty rule, and the false-positive fixes in `outcome` |
| note-edit | 50 | quantize arithmetic **pinned against a real measured run**, the half-strength outlier, note-count changes, and the record of how that run was misread twice |

### Full tier — the suites that leave this process

| Suite | Tests | What it protects |
|---|---|---|
| capability | 23 | that a destructive command refuses, and that "nothing errored" is never reported as success |
| integration | 24 | the MCP surface, the documented failure modes, and bridge liveness |
| blackbox | 25 | the adapter through MCP only, importing no internal module; and that no tool hangs |

### Black-box — the adapter, through MCP only

`blackbox.test.mjs` (count in the runner's per-suite block, not here) imports
**no internal module**. It spawns
`bin/cakewalk-mcp.js` as a client would, speaks JSON-RPC over stdio, and judges
only what comes back on the wire. It holds the adapter to five rules:

1. every tool is callable and answers within a bounded time
2. no tool raises an unhandled error at the protocol level
3. an error is a well-formed result with a readable message, never a timeout
4. a missing precondition is reported as such, with what to do about it
5. nothing that discards work happens without an explicit confirmation

**This layer caught a defect the white-box suite could not.** `cw_verify_commands`
surveyed 21 commands at roughly 2.5 s each with no cap, so a bare call left a
client waiting a minute. Every unit was fine; the composition was not. It now
takes a `budgetMs` and returns a partial result naming what it skipped. It is
also the only layer that can catch a wiring mistake — a module that works
perfectly but is never registered as a tool is invisible from inside.

Run everything with `node run-tests.mjs`, one suite with
`node --test test/edit.test.mjs`.

Twenty-seven real bugs came out of writing and auditing these, which is the argument for
the suite. Eighteen came from auditing rather than from writing:

- **10–14** from the first adversarial pass (five lenses, each finding re-checked by a
  separate agent told to falsify it)
- **15–18** from attacking those fixes
- **19–24** from attacking the fixes again — the second pass found the most, because
  that is where the fixes had never been independently examined
- **25–27** from a third pass aimed at the crash paths and at the measurement habits
  themselves: the two findings that matter most there are that four tests were green
  only because they skipped, and that a repair made a test pass by making it unable to
  fail — caught only by mutating it

1. **Pan was asymmetric.** `Math.round(64 + n * 63)` put hard-left at 1 instead of
   0 (MIDI's halves are 64 and 63 steps, so one multiplier cannot be symmetric) and
   made `describePan(0)` read `102% left`. Fixed by scaling each side by its own span.
2. **`CC.pan` vs `CC.PAN`.** Three modules, two spellings, and an undefined
   controller masks to **CC0** — so a cross-module call silently wrote a bank-select
   instead of a pan. Both spellings now resolve, and a non-numeric controller throws.
3. **Unterminated notes were dropped.** A note-on with no note-off (a trimmed or
   truncated file) vanished entirely. They are now kept, flagged, and reported.
4. **The test framework itself.** `documentState()` starts the PowerShell bridge,
   which is long-lived by design; four orphaned processes from one run slowed the
   next suite into a 60-second timeout. Added `shutdownShims()`.
5. **`risk` held prose, disabling the guard.** Three destructive commands had
   `risk: 'destructive — the source events are replaced'`, and the guard compares
   `=== 'destructive'`. The confirmation check was silently off for all three. The
   test that caught it pins the canonical value *and* runs every destructive command
   to confirm each actually refuses — checking the field alone would not have.
6. **`cw_edit` reported a dialog that had not opened.** `outcome` fell back to the
   command's *description* when no window appeared, so a failed run read like a
   successful one. Measured: `newWindows` was empty while `outcome` claimed a
   dialog. Now `outcome` carries only what was seen and `expected` the description.
7. **A stale modal made a working command look broken.** With four leftover modal
   windows on screen, `cw_edit quantize` reported `no-window-change`; on a clean
   state the same call opened its dialog. `likelySwallowed` now says so and names
   `cw_list_overlays` / `cw_close_overlays`.
8. **`preconditionSatisfied` claimed an outcome nothing could observe.** It read
   `'selected all first'`, asserted unconditionally from the `selectFirst` flag.
   Select-all is a *drawn* change — no window, no element, just a highlighted
   ruler — so a modal that swallowed the menu command (which #7 shows happens)
   left the field claiming a selection it never made, sitting next to a
   `likelySwallowed: true` saying the command had vanished. Now `selectionRequested`
   reports the attempt, `selectionConfirmed` is always `false`, and
   `selectionEvidence` says a screenshot is what would settle it. This one is the
   same defect as #6 in a different field, which is why the fix came with a test
   asserting the old name is *absent* from the result.
9. **The measured "50%" row was described more confidently than it holds.** The
   prose said 50% strength "moves each note *half* way to the grid". Recomputing
   `predictQuantize` against the recorded run: seven of eight notes agree to within
   a tick of rounding, but one (2461 → 2432) is **59 ticks** off the linear model.
   One sample cannot say why, so the claim is now stated as a table with the
   outlier named, and `predictionConfidence` is `exact` only at 100% strength.

The next five came out of an adversarial audit — five independent lenses, every
finding re-checked by a separate agent whose instruction was to falsify it. They
are listed separately because the failure mode is different: these were not
reasoning errors but **reporting** errors, each of which would have led a reader to
the wrong action.

10. **`judgeQuantize` could not tell "nothing moved" from "the commit failed".**
    With `strength: 0` the prediction is also "no movement", so `before == after`
    matched the prediction and produced the reassuring *"partially moved — this is
    a fractional strength result, not a failure"*. A quantize that never applied
    read exactly like a legitimate no-op. It also explained a **changed note count**
    as "the dialog may have applied different settings than were written" — sending
    a user back to the dialog instead of looking for the missing note. The verdict
    now branches on the count first, then on whether anything moved at all.

11. **`describeNavigateResult` had the same false-positive shape as #6, unfixed.**
    `confirm === 'dialog'` produced "A dialog should be open" while never consulting
    `newWindows` — the evidence was in hand and unused. Worse, `next` had two
    branches for three evidence classes, so `confirm: 'elements'` (only
    `showMarkerView`) fell through to the *drawn-change* wording and emitted a
    sentence arguing with itself: "drawn, not exposed" followed by "is a TABLE —
    readable". Each class now has its own branch, and a test walks the real tables
    so a fourth class cannot be added without wording.

12. **Three zero-argument tools hung past a client's patience.** Found when the
    black-box walk timed out at 60 s: `cw_add_song_tracks` (six inserts at 2–4 s
    each), `cw_benchmark` and `cw_latency`. The audit's first guess — the plugin
    inventory — was only part of it; profiling showed four *write* cases posting a
    command and then waiting for the UI account for ~55 s of the benchmark's 70 s.
    All three now take a budget or default to the cheap stages, and each says what
    it skipped. `cw_latency` also orders its stages cheapest-first, because the
    budget is consumed in order and the expensive stages were starving the 22 ms
    MIDI measurement.

13. **`events` was unreachable through MCP, so a guard could never fire.**
    `cw_write_midi_file` documented a channel-mismatch warning, but its zod schema
    only exposed `notes` — and zod strips unknown keys, so a client sending `events`
    had it silently dropped. The test "the writer warns when a track mixes channels"
    asserted only `!isError` and could not fail. `events` is now in the schema, and
    the test drives the path that can actually warn.

14. **The marker-removal commands had empty records.** `removeProjectStart/End/Range`
    carried an id and a name and nothing else — no `effect`, no `confirm`, no
    `verified` — sitting in a table of measured commands. They now state what they
    do, how they would be confirmed, that they are destructive, and that they were
    **never probed**.

Four more came from attacking the fixes themselves, which is the stage that found
the most in the end:

15. **`judgeQuantize` reported a SUCCESS as a suspected failure.** "Nothing moved"
    has reasons that are not failure — the source notes may simply already be on the
    grid. The rewritten verdict only recognised a zero strength, so quantizing an
    already-quantized file produced *"the commit most likely did not apply"*. The
    input decides this, so it is decided: `beforeOnGrid` is computed and the case is
    labelled a success. (It also explains why quantizing a tidy file proves nothing
    about the round trip.)

16. **A boolean was accepted as a strength.** `Number(true)` is `1` and
    `Number(null)` is `0`, so a bare coercion treated `strength: true` as a valid 1%
    and reported no warning. Only a number or a numeric string is a strength now;
    anything else falls back to 100 **and says so**.

17. **`whatToLook` vanished on both dialog branches.** A command that opens a dialog
    *and* names what to look at lost the second half — at exactly the two moments a
    caller needs it ("a dialog should be open", "no dialog appeared"). Every branch
    now carries it, and a test sweeps all commands in both window states for
    unfilled placeholders and doubled punctuation.

18. **Three tests that claimed to guard something and did not.** The `cw_edit`
    window-list regression survived **two** rewrites of its test before the third
    caught it — see [Mutation-test any test that claims to guard
    something](#mutation-test-any-test-that-claims-to-guard-something). The one
    lesson worth repeating here: a test asserting that two values from the same
    function agree cannot detect an error they agree about.

The second verification pass attacked the fixes above and found six more. Every
one is the same species — **the record claiming more than was established**:

19. **Cost figures I invented.** "Each insert costs roughly 2-4s, so six tracks
    need about 20s" — measured, one insert takes **~19s**, so six need ~2 minutes.
    The same error appeared three times: `cw_latency` said a menu post costs "~4s"
    (measured 11s), and `cw_verify_commands` said "~2.5s per command" (measured
    **~15s**). The last one had consequences: the budget default was set from that
    estimate, so 12s bought *one* probe and 45s bought three, neither of which is a
    survey. The comment now carries the measurement and its date.

20. **A test that substituted its own arguments.** The black-box "no tool hangs"
    check passed `budgetMs: 3000` to `cw_verify_commands` — a value that existed
    nowhere in the product. The real default was 45s against a 58.7s workload, so a
    bare call in the wild blew the client timeout while the test stayed green. It
    now calls every tool with **no arguments**, because the defaults *are* the
    contract, and tools that are slow by nature get an explicit ceiling instead of
    an exemption.

21. **A fabricated witness.** The three `removeProjectStart/End/Range` commands
    were marked "not probed" and then given `confirm: 'screenshot'` plus a
    `whatToLook` sentence describing what probing would have found. Inventing a
    plausible witness for an unmeasured command is worse than admitting the gap,
    because it reads as knowledge. They now carry `confirm: 'unprobed'`, and the
    branch that handles it says NOT PROBED.

22. **A count change hid a success.** `judgeQuantize` fired its count-changed
    branch before any position comparison, so a legitimate count change (SONAR
    merges same-pitch overlaps on export) reported "not a quantize result" while
    every surviving note sat exactly on the grid. Both facts are now reported.

23. **Clamping was silent.** `strength: 150` became 100 and `strength: -10` became
    0, reported as valid with no warning. `strengthAdjusted` and a message now
    accompany any value that was not used as given.

24. **A whole table was exempt from the rule.** The check "every command declares
    how it can be confirmed" skipped `ARRANGER_COMMANDS` wholesale, so a command
    added there with an empty record would pass. The rule is now per-command:
    `unprobed` is a legitimate declaration, silence is not.

A third pass turned on the *adapter's own crash path* and on the measurement
habits used to check it. Three findings, all the same shape — **a conclusion that
rested on an unverified assumption**:

25. **A crash on the most common state, hidden by tests that skipped themselves.**
    `capabilities()` returned early when SONAR was not running and left
    `transports` an **empty object**, while `runCommand()` and
    `cakeScriptBlocker()` dereferenced `transports[...].available` unconditionally.
    Starting with SONAR closed — the single most likely way a user meets this
    adapter — produced `Cannot read properties of undefined (reading 'available')`
    instead of the documented `CAKESCRIPT_UNAVAILABLE` with its alternatives.
    Four tests covered this path and all four opened with
    `if (!r.result.isError) return;`, so with SONAR *running* they asserted
    nothing. They were green because they never ran, not because the code was
    right. Fixed by populating every transport with `available: false` and a
    reason; guarded by a test that asserts the invariant regardless of what SONAR
    is doing (mutation-checked: bug in → red).

26. **A verification that used the wrong command id, and nearly produced a wrong
    "bug".** While checking why an edit test failed, I posted `0x8099` to open the
    quantize dialog and it "worked". It is not 处理 > 量化. The real id is
    `0x8061` (`lib/edit.js` had it right all along). `0x8099` happens to open a
    different `#32770`, and the resemblance was enough to build a whole chain of
    wrong conclusions on top of a control experiment that was never valid. The
    lesson: when a probe succeeds unexpectedly, confirm it is the *same* operation
    before using it as a control — a screenshot of the dialog, not just the window
    class.

27. **A test weakened to make it pass, caught by mutating it.** The `cw_edit`
    end-to-end test asserts a dialog is on screen after a quantize. With an
    *empty* project open (tracks, no notes) quantize is legitimately silent, and
    the test failed on correct code — its third non-bug failure. The first repair
    relaxed the assertion to "the report should be honest about seeing nothing",
    which **passed even with the plumbing regression injected**: the two cases are
    indistinguishable. Fixed twice over — the regression now has a deterministic
    guard where it can be told apart (`requireWindowList()` raising
    `EDIT_WIRING_FAULT` when the window list did not survive `withSelection`,
    covered by three process-free tests), and the end-to-end branch is `t.todo()`
    rather than a green assertion it cannot earn. A silent pass for an
    unverifiable state is the same trap as finding 18.

Two conventions the tests pin that are not obvious from the code: `parseInventoryKeyNames()`
returns an array **with a `scannedOnly` property attached**, so `deepEqual(result, [])`
fails on it; and the pan round trip is asymmetric by one percent near the half
positions because of the 64/63 split — a fact about MIDI, not a bug.

A third is a habit rather than a convention: the `note-edit` suite runs its
arithmetic against **ticks recorded from a real SONAR session**, so a change to
the model of how quantize behaves has to argue with an observation rather than
with a plausible-looking formula.

### Mutation-test any test that claims to guard something

Writing a regression test is not evidence that it works. The `cw_edit` window-list
bug is the cautionary case: it was "fixed", a test was written for it, and an audit
later showed the test was vacuous. Two rewrites failed too, and only the third
worked — and the third was believed only because it was checked by **injecting the
bug back**:

```bash
cp lib/edit.js /tmp/bak.js
sed -i 's/const { out: ran } = await withSelection(/const ran = await withSelection(/' lib/edit.js
node --test test/integration.test.mjs    # MUST fail
cp /tmp/bak.js lib/edit.js
node --test test/integration.test.mjs    # MUST pass
```

What the three attempts taught, in order:

1. **A test built on the code's own output is a tautology.** The first version
   asserted `outcome` matched `newWindows` — but `outcome` is *computed from*
   `newWindows`, and it has exactly two values. It could not fail.
2. **A consistency assertion cannot detect a consistent error.** The second
   version asserted the two *agreed*. Injecting the bug, they agreed perfectly:
   both were empty. 24/24 green against broken code.
3. **Assert against a fact from outside the code under test.** The third version
   asks the overlay list whether a dialog is actually on screen. That is not
   derived from the thing being tested, so it can disagree with it.

Two smaller lessons came from getting even that right. The assertion must match on
the window **class** (`#32770`), not the title — SONAR's captions are GBK and
arrive as `��������`, so a `/量化/` match fails while the dialog sits plainly open.
And a test that drives the live app must **reset the screen first and clear up
after**, because a modal left by an earlier test swallows menu commands and makes
the next test fail for an inherited reason; `integration.test.mjs` and
`blackbox.test.mjs` both do this in `test.after`.

## Registering with ZCode

Already done in `C:\Users\molisaa\.zcode\cli\config.json`:

```json
"cakewalk": {
  "type": "stdio",
  "command": "<package>/runtime/node.exe",
  "args": ["<package>/bin/cakewalk-mcp.js"],
  "env": {}
}
```
