# The surface mechanism, measured

Written after the work described in the README's "control-surface bridge"
section. Every claim here has a measurement behind it; the raw evidence is in
`cw_surface.log` next to the built DLL and in the RTTI addresses quoted below.

## 1. What SONAR passes to Connect

`IControlSurface::Connect(IUnknown* pUnknown, HWND hwndApp)`.

`pUnknown` is a **`CCtrlSurface`** — recovered, not guessed:

| Step | Result |
|---|---|
| vtable RVA from the log | `0x1433505D8 - 0x140000000 = 0x33505D8` |
| On disk | `.rdata`, `[vtable-8]` = MSVC `RTTICompleteObjectLocator` |
| TypeDescriptor name | `.?AVCCtrlSurface@@` |
| Class hierarchy | `CUnknown`, `INonDelegatingUnknown`, `CBaseObject`, `CMidiInputMonitor::CObserver`, `CCtrlSurfaceBase` |
| vtable size | 13 slots |

The 13 slots line up exactly with `IControlSurface`:

```
slot  0  QueryInterface            0x16d80f0   compares IIDs (mov rax,[rdx])
slot  1  AddRef                    0x10d1e50   lock inc [rcx+0x10]
slot  2  Release                   0x10d1ec0   lock xadd [rcx+0x10]
slot  3  GetStatusText             0x040b9a0
slot  4  MidiInShortMsg            0x3546fd8   (.rdata — data, not code)
slot  5  MidiInLongMsg             0x040c1ec   sub rcx,0x18; jmp  (thunk)
slot  6  Connect                   0x16d6a70
slot  7  Disconnect                0x16d6870
slot  8  RefreshSurface            0x3547000   (.rdata)
slot  9  GetNoEchoMask             0x16d6440
slot 10  GetVersion                0x16d6340
slot 11  GetNoEchoStatusMessages   0x16d61a0
slot 12  (IControlSurface2 begins) 0x16d6100
```

So the host object **is itself an `IControlSurface` implementation**, with 13
slots — not the 44-slot `IControlSurface3`, and not the 59-slot `CSonarMixer`.
**It does not carry `SetBaseTrack` or `SetTargetParam` at all**, which is why no
amount of guessing its IIDs could have found them.

### The three IIDs it does answer to

Extracted from the disassembly of its own slot 0:

```
{ED0C14F0-40F3-4459-813C-CB5B5A5E4958}   -> S_OK
{85F8BB17-75F8-497F-8319-EF33A632C380}   -> S_OK
{55507DE1-C037-4682-A4EC-65B1D2E86B53}   -> S_OK
```

Each QI hands back a distinct pointer with its own vtable (5, 6 and 8 slots
respectively — multiple inheritance gives each base its own vtable). Their
slots 0-2 are forwarding thunks of the form
`mov rcx,[rcx+10h]; mov rax,[rcx]; jmp [rax+8*N]`, and the remaining methods
allocate large frames with parameter validation. They are not per-parameter
setters.

## 2. What the surface interface is actually FOR

Disassembling the shipped `GenericSurface.dll` settled the direction, and it is
the **opposite** of what the plan assumed:

| Method | Shipped implementation | Meaning |
|---|---|---|
| `SetTargetParam(mixerParam, dwParamNum)` | `mov rcx,[rcx+0xF0]` — reads its OWN state | SONAR tells the surface a value changed, so it can move its fader/LED |
| `SetParamMidiMsg` | `mov eax,0x80004001; ret` = **`E_NOTIMPL`** | The surface does NOT declare a MIDI mapping |
| `GetTargetParam(nParamIx, pMixerParam, apdwParamNum)` | returns from `+0xF0` | the host asks the surface what it is showing |

So the interface is **host → surface notification**. A surface does not push
values into SONAR through it. `CGenericSurfaceStrip`, the object that actually
holds mixer state, is 12 slots and is reached through a global table by index
(one `MidiInShortMsg` failure path returns `0x8002000B` = `DISP_E_BADINDEX`,
which is an IDispatch error code — evidence the lookup is indexed).

## 3. The direction that DOES work: MIDI

A surface's only channel back into SONAR is MIDI, and it needs one thing: the
surface must be assigned the right **input port**.

Measured, after setting 输入端口 to the loopback port `Studio One AI Notes`:

```
before: 0
after : 11
  0xB0 d1=7  d2=20     CC7  volume
  0xB0 d1=7  d2=35
  ...
  0xB0 d1=10 d2=64     CC10 pan
  0xB0 d1=1  d2=10     CC1  modulation
  0x90 d1=0  d2=100    Note On
```

**11 of 11 messages arrived**, with status, data bytes and arrival tick. Before
the port was set, the count stayed at 0 — the surface was bound to the audio
interface instead, so nothing was routed to it.

This is exposed as `cw_surface_midi_in`.

## 4. What is still open

Turning received MIDI into a track edit. The surface would have to map
"CC7 on channel 1" to "set volume on base track + N", and it has no mixer
interface of its own to do it with — that lives in `CGenericSurfaceStrip`
behind the indexed global table.

Closing it needs one of:
- the `SURFACEFRAMELib` type library — **not on disk, not registered, and no
  DLL in the set will load with `LoadTypeLibEx`** (all return
  `0x80029C4A TYPE_E_CANTLOADLIBRARY`; `LoadRegTypeLib` returns
  `0x8002801D TYPE_E_LIBNOTREGISTERED`). It was a compile-time `#import` only.
- disassembly of `CGenericSurfaceStrip`'s mixer path through the global table.

**Not** by calling unknown slots: that crashed SONAR with `C0000005`
(`MiniDumps/Untitled_10162026_020341.dmp`). Isolation protected the bridge, not
the host.

## 5. The object's memory layout, read directly

`op:"dump"` reads the host object without calling anything. Measured:

```
+0x000  0x1433505D8   <- vtable  (CCtrlSurface, 13 slots)
+0x008  0x7FB5EC0     <- heap pointer (back-reference)
+0x010  0x6           <- reference count
+0x018  0x143350600   <- second vtable
+0x020  0x143350620   <- third vtable
+0x028  0x7F9C6C0
+0x030  0xD           <- 13
...
```

All three vtables carry the **same RTTI name**, `.?AVCCtrlSurface@@`, and they
are nested rather than distinct:

```
main        (13 slots)  [0 .. 12]
+0x18 sub   ( 8 slots)  [5 .. 12]     <- same functions, entry point at 5
+0x20 sub   ( 4 slots)  [9 .. 12]     <- same functions, entry point at 9
```

That is the standard MSVC multiple-inheritance layout: one implementation, one
`this`-adjusting sub-object per base, each with its own vtable. **There is no
hidden mixer interface in this object.** Combined with the class hierarchy
(`CUnknown`, `INonDelegatingUnknown`, `CBaseObject`,
`CMidiInputMonitor::CObserver`, `CCtrlSurfaceBase`) the picture is complete: the
host is a MIDI-input observer that implements `IControlSurface` for the purpose
of *notifying* a surface, and nothing else.

### Two defects this measurement exposed

1. **Addresses must not travel as JSON numbers.** A 64-bit pointer exceeds
   JavaScript's safe integer range, so `0x1433505D8` arrived at the client as
   `ffffffff` — a rounded value that reads as corruption. Addresses are now
   emitted as hex strings and parsed with `BigInt`.

2. **`wsprintf` has no `ll` length modifier.** Formatting the address with
   `wsprintfA(..., "%llX", ...)` corrupted the argument walk and **killed the
   worker thread**: every later request timed out while SONAR itself stayed
   healthy and kept calling `RefreshSurface`. That "bridge dead, host alive"
   signature is the same one the unescaped-JSON bug produced. `wsprintf` is
   user32's reduced printf; the 64-bit path uses the CRT `sprintf` instead.

A third, unrelated fix came out of the same session: `ModuleOf` re-enumerated
every loaded module on each call, which made a 24-address dump exceed the client
timeout. The module table is now cached after the first lookup.

---

## The mixer IS reachable, and calling it is still the wrong move

Everything above concluded the host implements `IControlSurface` and "nothing
else". That conclusion was about the host *object*. The host also **holds** COM
objects, and one of them is the mixer. Read out of `Sonar.exe`:

```
host+0x38 -> vtable 0x14340ECF8   .?AVCSonarMidiOut@@
host+0x48 -> vtable 0x14340EC28   .?AVCSonarCommands@@
host+0x58 -> vtable 0x14340EE08   .?AVCSonarMixer@@      <- 18 methods
host+0x78 -> vtable 0x14340F268   .?AVCSonarParamMapping@@
host+0x80 -> vtable 0x14340F868   .?AVCSonarUIContext@@
```

The measurement that nailed it: each of those slots holds a **pointer to** an
object whose first word is the vtable. Following `host+0x58` to the object and
reading its `[0]` gives `0x14340EE08`, and reading *that* gives eighteen method
addresses in `Sonar.exe` — identical to the static extraction.

`CSonarMixer`'s inheritance chain is `ISonarMixer3 -> ISonarMixer2 ->
ISonarMixer`, and slots 0-2 are forwarding thunks to `[this+0x10]`, which is the
host `CCtrlSurface` object itself: the standard delegating-unknown pattern.

### Slot 6 is a getter, and its arguments are pointers

Slot 6 (`RVA 0x1C562B0`) was disassembled instruction by instruction and looks
exactly like a parameter accessor:

```
mov  [rsp+18h], r8d        ; arg2 saved
mov  [rsp+10h], edx        ; arg1 saved
mov  r15d, r9d             ; arg3 -> parameter selector
cmp  r15d, 38h             ; 0..56, the documented parameter enum
mov  rcx, [rdi+0c68h]      ; this->paramTree
cmp  dword ptr [rax+1Ch], r15d
mov  esi, 80004001h        ; E_NOTIMPL when the parameter is absent
```

Calling it with three integers gave a clean discrimination — proving `arg3` is
the parameter — and then this:

| args (a1, a2, a3) | HRESULT |
|---|---|
| 1, 1, 20 (a key present in the tree) | `0x80004001` E_NOTIMPL |
| 1, 1, 9999 (absent) | `0x00000000` S_OK |
| 1, 1, 0x38 (the special-cased value) | `0x80004005` E_FAIL |
| 1, **20**, 1 | **crashed** |
| **20**, 1, 1 | **crashed** |

Both crashes are the same fault:

```
Exception Code:    C0000005
Exception Address: 0x141C573A6      <- inside slot 6
Access Address:    0x0000000000000000
Faulting Module:   Sonar.exe
```

**A null read from inside the method, reached by passing a small integer where a
pointer belongs.** So slot 6 is `GetTargetParam(param, out...)`: `a1`/`a2` are
out-parameters, and three integers is the wrong calling convention for it.

### The rule this establishes

> An unknown virtual method cannot be identified by calling it with different
> arguments and reading the result, even when its disassembly looks understood.
> Here the bounds check, the E_NOTIMPL path and the parameter selector were all
> read correctly, and the method still faulted on an argument that meant
> something other than what the disassembly suggested.

The `call` opcode stays in the plugin — it is what made the discrimination above
possible, and its watchdog and `hostOff` resolution are sound. But it is a
diagnostic, not a write path. **The mixer was never needed:** the track strips
already expose mute, solo and arm, and a real click on them works. See
`lib/track-ui.js` and `native/uia/`.

### Cost of getting there

Five SONAR crashes, each producing a multi-megabyte dump in
`%APPDATA%\Cakewalk\Sonar\MiniDumps`. SONAR's own crash handler generally
survives them — it offers to save a recovery copy and then exits — so a crash is
not fatal to the project, but it does kill the plugin's worker thread, and a
dead worker presents as "the bridge is listening and answers nothing".

Two further defects were found and fixed while doing this, both of the same
family as the `wsprintf` bug above and both worth naming because they are easy to
reintroduce:

3. **`wsprintfA` with `%llX` again**, in the new `call` reply. The exact bug
   recorded earlier, reintroduced. Same signature: `USER32.dll`, `wvsprintfA`,
   access address `0x1`. Any 64-bit value formats through CRT `sprintf`, and
   that is now stated at each site rather than once at the top.

4. **A call result written into a stack frame that had already returned.** The
   `CallJob` was a local in the request handler, and a call that outlived its
   watchdog kept running with a pointer into a dead frame. It is one static job
   now, which is correct because the worker is single-threaded.

---

## Pre-release adversarial audit (this section is the record)

Full white-box + black-box pass over all 97 tools, the bridges, the DLL and the
deploy scripts, run as a release gate. Findings, ranked:

**BLOCKER — fixed and verified live: `SendLine` truncated every reply over
1024 characters.** It copied the reply through `wsprintfA`, whose output is
capped at 1024 by the implementation (not by any buffer size), and the `\n` was
part of the truncated output — so long replies arrived without a terminator and
the client read them as a dead plugin. This is the probable true cause of the
historical "probe hangs" symptom previously blamed on handler length guards.
The fix is `lstrlenA` + `memcpy` + an explicit `\n` + a `send` loop; every
`wsprintfA(reply…)` site (31) was moved to CRT `sprintf`, which has no cap.
Verified live: a 1296-byte `dump` reply — over the old cap — now arrives whole,
and TCP fuzzing (split JSON, binary junk, 8KB unterminated lines, format-string
opcodes) leaves the worker answering correctly afterwards, including the
partial-line reassembly path.

**Defence in depth — fixed: `removeScript` accepted any filename.** Its only
caller passes names built by `scriptNameFor`, so it was not exploitable, but a
file-deleting function whose signature accepts any string is one future caller
away from a path traversal. It now applies the same name gate as
`writeScript` (`BAD_SCRIPT_NAME` for anything but `[A-Za-z0-9._-]+\.cal`),
verified with a `../../evil.cal` probe.

**Portability — fixed: template roots hard-coded this machine's D: layout.**
`CW_TEMPLATE_ROOTS` (semicolon-delimited) now overrides or extends the list.

**Disclosed, not changed: rename overwrites the user's clipboard.** The paste
path needs it, and silently saving/restoring clipboard state has worse failure
modes (non-text formats cannot round-trip). Documented at `renameTrack`.

**Verified clean, no change needed:**
* All 97 tools have zod input schemas; 97×4 adversarial argument sets produced
  zero process crashes and zero hangs (the 5 slow tools are budgeted
  long-runners, confirmed to return at 12–35 s).
* The MCP JSON-RPC layer silently drops malformed input and answers correctly
  afterwards.
* `execFile` with an argument array everywhere — no shell interpolation on any
  user-controlled path; `Find-Control` compares with `-eq`, not `-match`, so no
  regex injection; T5 refuses out-of-view and unknown-label requests with
  distinct, actionable errors.
* The TCP bridge binds loopback only (`INADDR_LOOPBACK`), rejects malformed
  input per line, and re-syncs after partial lines. Unauthenticated local
  access to port 39177 is a known, accepted property of the threat model: the
  bridge can do nothing the calling user cannot already do through SONAR's own
  UI running as the same user.
* No user-specific paths leak through tool outputs; the `D:/CAKEWALK` literals
  in `sonar.js`/`plugins.js` are entries in probe lists, not assumptions.
