# deploy/ — one-command install, uninstall, and what to ship

Current release limits and validation: [RELEASE-NOTES.md](../RELEASE-NOTES.md).
The optional surface component requires `CW_SURFACE_TOKEN` in both SONAR and MCP
process environments. It will not listen without a valid 64-hex token, and raw
memory/vtable diagnostics are disabled even with authentication.

The installer serializes concurrent runs in the same user session and never
restarts another application's loopMIDI instance. If such an instance has no usable
port, create a port in loopMIDI or restart it yourself when its other users are idle.

## For the person deploying this

Double-click `双击部署.cmd` in the project root. Keep it together with the complete
project folder. It runs this installer, saves a transcript under `deploy-logs/`,
and keeps the window open so failures can be read. No administrator launch is needed.

Alternatively, run:

```text
powershell -ExecutionPolicy Bypass -File deploy\install.ps1
```

That is the whole install. It checks prerequisites and installs npm dependencies,
then runs `cw_doctor`. Read the doctor line as well as `installed.`: the files and
dependencies are in place by then, but the verdict can still be `UNVERIFIED` or
name a channel that is down. There is
no third step: the control-surface DLL is opt-in (`-WithSurface`) and is not
touched by default — see "The per-session step is gone" below for why.

Uninstall:

```text
powershell -ExecutionPolicy Bypass -File deploy\uninstall.ps1
```

Then point your MCP client at `runtime\node.exe bin\cakewalk-mcp.js` — the runtime
ships inside the package, so the target machine does not need Node installed. That
is all: no per-session SONAR step, no computer-use runtime.

## What must ship

A deployment zip is the git-tracked tree (a prebuilt DLL is optional now, since
the default install does not use it):

| Path | Why |
|---|---|
| `bin/`, `lib/`, `bridge/` | the server itself |
| native/uia/ | the T5 helper (`.ps1` + `Mouse.cs`) — **keep the UTF-8 BOM on the .ps1** |
| **`runtime/`** | **105 MB: a portable copy of Node (node.exe + npm). This is what makes the package one-click on a machine that has never had Node.js.** |
| **`vendor/loopMIDI/`** | **7.8 MB: the vendor's own loopMIDI installer, bundled with the author's permission (see `NOTICE.txt`). Lets the install work with no network.** |
| **`node_modules/`** | **21 MB, pure JavaScript — no `.node`/`.dll` binaries, so it is portable. Ship it and the install needs no network at all.** |
| `package.json` | dependency manifest (still needed if `node_modules` is omitted) |
| `deploy/` | this install/uninstall pair |
| `双击部署.cmd` | double-click entry; calls `deploy/double-click.ps1` |
| `QUICKSTART.md` | the human-facing setup sheet |
| `AGENTS.md` | the agent-facing operating manual |
| `README.md` | the full technical reference |

Optional, only for `-WithSurface` (diagnostics): `native/surface/` in full,
including `native/surface/build/cw_surface.dll`.

**If `node_modules/` is omitted**, `install.ps1` runs `npm install` and therefore
needs access to the npm registry. That is the one dependency a clean machine
cannot supply by itself; shipping the folder removes it. `test/`, `tmp/`, and the
`.zcode` files are NOT part of a deployment.

## What a clean machine needs, verified vs not

Everything below was exercised on this machine unless marked otherwise.

| Requirement | Needed for | Status |
|---|---|---|
| Windows 10/11 x64 | everything | used throughout |
| **Node.js ≥ 18.19.0** | the server itself | **NO LONGER A PREREQUISITE — the package carries `runtime\node.exe` (93 MB, self-contained, no install, no admin).** Measured on a clean Windows 11 VM with no Node on PATH: step 1 reported `node 24.20.0 (bundled with the package)` and the install completed. The installer still falls back to a PATH `node` if `runtime\` has been deleted |
| **SONAR installed** | everything | checked by step 1; missing SONAR is a warning, not a hard failure, because the adapter can still be installed first |
| **`node_modules` or npm registry access** | the server itself | from-scratch `npm install` was verified on a clean copy (95 packages). **No-network was NOT tested** — ship `node_modules/` to remove the question |
| loopMIDI | realtime MIDI only (T4) | **detected by four independent methods** (running process → PATH → bounded search of Program Files/Program Files (x86)/LOCALAPPDATA → Start Menu shortcut), so a non-default install path is found. **The installer ships in `vendor/loopMIDI/`** (redistributed with the author's permission), so step 4 installs it with no network; winget and the official download remain as fallbacks. **A fresh loopMIDI has no ports**, which the adapter cannot use, so step 4 also writes the default port into loopMIDI's `Ports` key and restarts it — measured working: the port list went from empty to `loopMIDI Port` and the adapter then enabled it in SONAR. `-LoopMidi skip` turns all of this off and only reports |
| **SONAR's own C++ runtime** | SONAR starting at all | `Sonar.exe` imports `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` and `mfc140u.dll`. **Measured on a clean Windows 11 VM: the Cakewalk entry was in the registry and the exe was on disk, but all three DLLs were absent — every launch died with `0xC0000135` (STATUS_DLL_NOT_FOUND) and the installer still printed `installed.`** Step 1 now checks those four (System32 or app-local) and, when they are missing, says so and prints `installed, but SONAR cannot start yet.` instead of a clean success. Remedy: the Microsoft Visual C++ 2015-2022 Redistributable (x64) |
| **SONAR signed in / activated** | the click-based track tools (T5) | **measured on a clean install: not activated → the main window exposed 52 accessibility elements and none of the `<label> on Track N` controls; after signing in the same window exposed 402, including every track control.** So `cw_set_track_mute/solo/arm` and `cw_set_track_name` fail until SONAR has been signed in once. This is SONAR's own behaviour, not an adapter defect — nothing else is affected. **install.ps1 checks it** (step 4b) and says so when SONAR is running and not signed in. **Re-measured 2026-10-20: signing in is not sufficient — a `Free License` session exposed 69 elements with all five track strips present but ZERO children each, so the licence tier itself gates the accessibility tree. Writing music does not depend on it (file → import works)** |
| .NET Framework (Add-Type) | the T5 UI helper | built into Windows 10/11; used on every run |
| PowerShell 5.1 | the installer | built in |
| gcc / mingw | rebuilding the optional surface DLL | NOT needed on the default path — a prebuilt DLL ships and the surface is opt-in |
| Visual C++ redistributable | — | NOT needed: the surface DLL imports only KERNEL32/USER32/OLEAUT32/ADVAPI32/WS2_32/msvcrt (no mingw runtime DLLs were linked in) |

## What install.ps1 will never do

* No admin prompt and no HKLM registry writes **for the adapter itself**.
  Everything it registers lands in `HKCU\SOFTWARE\Classes` and the package folder.
  Two documented exceptions: installing a missing loopMIDI runs the vendor's
  driver installer (one UAC prompt; `-LoopMidi skip` opts out), and
  `-WithSurface` copies `cw_surface.dll` into SONAR's Shared Surfaces folder.
  The default run also edits `%APPDATA%\Cakewalk\Sonar\TTSSEQ.INI` and the
  loopMIDI `Ports` key under HKCU.
* No licence interaction of any kind. The surface plugin registers through the
  same COM discovery path (`HKCR\CakewalkControlSurfaces`) that SONAR's shipped
  surfaces use; it adds a capability, it does not alter one.

## The per-session step is gone (and what replaced it)

Earlier versions required adding the control surface in 参数设置 > MIDI >
控制界面 after **every** SONAR launch. That requirement is now removed, because
the mechanism was finally pinned down at function level rather than inferred:

* `Sonar.exe` exports `CCtrlSurface::PersistSurfaces` — the function that
  *writes* `ctrlsurface.dat` — and no `LoadSurfaces` / `RestoreSurfaces` /
  `InitSurfaces` symbol at all. The file is written and never read back.
* Measured consequence on this host: `ctrlsurface.dat` contained this adapter's
  CLSID (written 00:09), SONAR started at 00:16, and the module list of the
  running process afterwards did **not** contain `cw_surface.dll`.

So the surface only exists between the moment the user presses OK and the moment
SONAR exits. Nothing outside SONAR can restore it, and patching the host is out
of scope for this project. A deployment that needs it therefore cannot be
one-click.

The capability it provided is now reached by other means, which is why install
no longer touches it:

| Was the surface | Now |
|---|---|
| volume / pan | CC7 / CC10 baked into a .mid, read at project load (verified end to end) |
| mute / solo / record-arm | a real click on the track strip, read back to verify |
| rename / mute (CAL) / channel+port | CAL, which needs no licence |
| notes, export, track insert, templates | file or menu paths, never involve the surface |

`install.ps1` has no **step 3** (3/3.1/3.2, the surface) in its default run.
Steps 4 (loopMIDI) and 4b (SONAR sign-in state) always run. `install.ps1
-WithSurface` restores step 3 for diagnostics, and the script then prints the
per-session reminder in its NEXT STEPS block instead of claiming there is none.

## How reliable is the one-command install? (verification record, 2026-10-16)

"Reliable" here means: every failure mode either self-repairs, fails loudly
with a remedy, or is knowingly accepted. Each row below was executed, not
assumed.

| Verification | Method | Result |
|---|---|---|
| Full install on a clean copy | Deploy surface copied to a fresh Temp dir, `install.ps1` run end to end | Steps green: npm 95 packages, doctor runs and prints its verdict, exit 0 |
| Repeat install (idempotence) | Same copy, second full run | Green again — no state conflict |
| Default run does not touch the surface | `install.ps1` with no flags on a host that HAS a registered DLL | Reports step 3 as SKIPPED, leaves the registration alone, exit 0 |
| `-WithSurface` still works | Same script with the flag | Builds/registers/copies exactly as the old default did (steps 3, 3.5, 4, 4b), and its NEXT STEPS block prints the per-session reminder |
| Corrupted DLL (opt-in path) | Truncated the DLL to 1000 bytes and backdated it to 2020 | Rebuilt from source on next `-WithSurface` install (F8 logic), size back to 326,961, re-registered |
| Stale/wrong registration (opt-in path) | Planted `C:\nonexistent\fake.dll` in the CLSID key | regsvr32 overwrote it; the key points at the new copy afterwards |
| npm fails | Injected a failing npm invocation (audit F7 scenario) | Script aborts with "npm install failed (exit N)"; the completion line is never printed |
| Uninstall leaves nothing | `uninstall.ps1` after a real install, then registry query | `registry clean: True`; both CLSID keys gone |
| Doctor call cannot hang the install | Found the hard way: doctor's host probe opens the long-lived user32 shim child, whose stdio pipes kept node alive after the verdict printed — under redirected stdout the buffered output never flushed and PowerShell waited forever | Fixed with an explicit `process.exit(0)`; doctor now returns in ~3 s and F7's UNVERIFIED warning is proven to fire when the doctor call fails for any reason |

Two things install deliberately does NOT verify (and says so):

1. A from-scratch machine without Node/gcc — the script checks prerequisites and
   fails with a named remedy, but a full clean-machine matrix has not been run.
   (gcc is no longer required at all on the default path: it is only needed to
   rebuild the optional surface DLL.)
2. That SONAR's MIDI input ports are enabled — deliberately, because writing
   `MaxInPort` incorrectly silently disables working inputs. The script reports
   the state and names the two supported ways to change it.

## The two discovery paths, and which one actually matters

This section applies only to `-WithSurface`. SONAR finds a control surface two
ways, and that install satisfies **both** because the cheap insurance costs one
file copy:

1. **COM registration** — `HKCU\SOFTWARE\Classes\CLSID\{7C4A9B21-…}\InProcServer32`
   pointing at the built DLL. install.ps1 step 4.
2. **A loose DLL in the scanned folder** — the directory named by
   `HKLM\SOFTWARE\Cakewalk Music Software\Shared Surfaces\InstallDirectory`,
   where SONAR's own five surfaces live. install.ps1 step 4b copies
   `cw_surface.dll` there.

A third-party tester hit a picker with no MCP entry and concluded only path 2
works. That was wrong, and the decisive experiment is cheap: hide the folder
copy, restart SONAR, expand the picker — six candidates appear, the MCP surface
among them. **Registration alone is sufficient on this host.** But path 2 is
real too, and which one a given install depends on has not been characterised
across SONAR versions, so both are written rather than betting on one.

A related correction, because it would silently break a configured machine:
`MaxInPort=-1` in TTSSEQ.INI does **not** mean "all devices". The key holds the
**highest device index**, so `-1` is the pristine, nothing-enabled state. The
install script therefore only ever *reports* MIDI port state; it does not write
that key. Selecting ports stays a user action in 参数设置 > MIDI > 设备.

To re-run this verification yourself: copy the deployment surface to a fresh
directory, run `deploy\install.ps1` there, break one thing, re-run, then
`deploy\uninstall.ps1` and check the registry. The E2E loop takes under three
minutes including npm.


---

## Building the distributable

`npm pack` is **not** the distributable: it produces a ~1 MB tarball with none
of `runtime/`, `deploy/`, `vendor/` or `node_modules/`, so the published
artefact cannot be the one-click, no-Node package this README describes. The
distributable is a zip of the tree:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\make-package.ps1
```

It stages exactly what a user needs (no `test/`, no `.zcode/`, no audit notes),
zips it to `dist/cakewalkmcp-<version>.zip`, and prints the MCP client command.
