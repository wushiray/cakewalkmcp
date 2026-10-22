# native/uia — reading and writing SONAR's track strips

The transport the adapter calls **T5** (`uia-click`). It is what made
`cw_set_track_mute`, `cw_set_track_solo` and `cw_set_track_arm` work after they
had been dead since CakeScript turned out to be unavailable on this build.

## The mechanism, in one paragraph

SONAR's track strips expose every control to accessibility. With a project open,
a **plain UIA client** sees 139 elements for the main window and 82 track
controls, each named `<label> on Track <N>` and carrying a live value. Reading
that way always worked. Writing did not — the accessibility *actions*
(`AXSetValue`, `AXToggle`, `AXPress`) are accepted and do nothing. But a **real
mouse event at the control's centre** does change it, and the value then reads
back changed. So: locate through accessibility, act with a real click, verify
through accessibility. All three parts are required.

```text
{ "control": "mute", "track": 65, "requested": "打开",
  "before": "关闭", "after": "打开", "clicked": "922,654",
  "changed": true, "alreadyThere": false, "verified": true }
```

`verified` is the field to trust.

## Files

| File | What it is |
|---|---|
| `cw_uia.ps1` | The whole transport: `dump`, `find`, `toggle`, `set`, `click`, `listtracks`. Prints one JSON object. |
| `Mouse.cs` | DPI-aware `SetCursorPos` + `mouse_event`. Compiled at runtime by `cw_uia.ps1`. |
| `probe-visibility.ps1` | Diagnostic: how many elements a plain UIA client sees. This is the measurement that disproved "a plain UIA client sees 2 elements". |

Driven from Node by [`lib/track-ui.js`](../../lib/track-ui.js).

## Three traps, each of which cost real time

**1. The `.ps1` must keep its UTF-8 BOM.** Every label compared in it is Chinese
(手动静音, 独奏, 录制, 打开, 关闭). PowerShell 5.1 decodes a `.ps1` as the system
ANSI codepage unless the file starts with a BOM. Strip it and the literals are
mis-decoded: the clicks still work, `before`/`after` still read correctly, and
only the comparison against the requested state fails — so `verified` returns
false on a write that actually succeeded. First three bytes must be `EF BB BF`.

**2. The clicking process must be DPI-aware.** UIA bounds and `SetCursorPos` are
both physical screen pixels and agree directly — but only from a process that
called `SetProcessDPIAware`. Otherwise coordinates are virtualised and every
click lands 1.5x off on a 150% display, which looks exactly like a control that
ignores clicks. On this machine the screen is 2560x1600 at 150%.

**3. Pick the main window by class, not by position.** SONAR owns several
top-level windows: the main frame (`Sonar`), `SysShadow` tooltip shadows, a
hidden `Internet Explorer_Hidden`, HUD panes. Taking the first child of the pid
worked only while enumeration happened to list the frame first; once a tooltip
appeared, the first child was `SysShadow` with zero descendants, and every track
control read as absent. `Get-Root` now matches `ClassName -eq 'Sonar'`.

## What it refuses to do

**A track scrolled out of the Track view is refused, not clicked.** SONAR still
reports a `BoundingRectangle` for a strip outside the view's clip region, and
still reports `IsOffscreen = false` — so an `IsOffscreen` check is not enough and
was tried first. Measured on track 58 of a 71-track project: the mute button
reported `[905,378,33,33]` while the Track view's client area began at `y=474`,
and clicking it did nothing. The guard is geometric, against the `CTRACKVIEW`
container's own rectangle. Refusing matters more than it sounds: a blind click
there is a **wrong** write rather than a failed one.

**Sliders and routing are not driven.** 音量 / 声像 / 增益 take a value through a
pattern SONAR ignores, and 输入 / 输出 open a picker. Use `cw_midi_*` for volume
and pan.
