# cakewalkmcp 0.2.0

Public prerelease for Windows x64 and Cakewalk SONAR, with the coverage limits
listed below. The release ZIP includes Node.js,
JavaScript dependencies, the unmodified loopMIDI installer and deployment scripts.
The repository contains source; use `npm ci --ignore-scripts` and `npm start` for
a developer checkout. For deployment use the portable ZIP and `QUICKSTART.md`.

## Audit fixes

- Command surveys use a fixed safe allowlist, stop at modal dialogs and never
  insert tracks, record, or toggle every track. Destructive command confirmation
  is shared by raw IDs, LOWORD aliases, classified commands and named wrappers.
- Standard dialogs are preserved by default. Dismissing them requires both
  `closeDialogs:true` and `confirm:"closeDialogs"` and can discard unsaved work.
- CAL note deletion requires `confirm:"deleteNotes"`. Duration and velocity
  scaling use a wide temporary before clamping; intervals are validated and
  added pitches stay in the MIDI range.
- INI edits preserve UTF-8, BOM-tagged UTF-16 and supported Windows ANSI encodings.
  Unrepresentable names fail before the original is changed.
- Template lookup handles Windows paths, case-insensitive ambiguity and refreshed
  roots. Verification requires a matching name on a newly observed track ID.
- MIDI panic no longer reports success without a port or after a failed send/reset.
  T1 detection is distinguished from implemented IPC; transport retains menu fallback.
- The optional surface listener requires a matching 64-hex `CW_SURFACE_TOKEN` in
  both processes. Raw `read/dump/call/qi/probe` operations are permanently disabled.
  Timeouts tear down all pending calls; idle, slow and oversized peers are bounded.
- The installer holds a per-user-session mutex. It restarts only the loopMIDI
  instance it launched, checks PID and start time, and verifies the executable's
  Authenticode publisher before launching it. Other applications' instances are
  preserved; add a port manually or restart loopMIDI yourself when they are idle.
- Full benchmarks no longer insert a bus. Source and installer diagnostics,
  command evidence, coordinate guidance and uninstall documentation were corrected.

## Validation

Final frozen-source results are recorded in `AUDIT-RESPONSE-20261022.md`.
Node 18.19.0 and 24.20.0 each passed **543 tests / 38 suites**, with zero failures
or skips (29 test files). The wrapper's 581 events include suite completions.
Automated tests use a no-host shim fixture by default, with real PowerShell
installer fixtures. They do not establish audible output or live-host editing.
`--live-host` enables real DAW/MIDI actions and requires a disposable project.

The native surface worker was separately compiled and checked against real local
sockets, outside SONAR. The current host smoke checks MCP startup, 89 default tools,
conversion, an owned MIDI-file roundtrip, doctor, document state and status.

## Limits and coverage

- CakeScript IPC is detected but not implemented. T1-only tools return an error
  with alternatives; subscribing to SONAR does not implement this adapter's IPC.
- Paid-license track writes and a completed 24-hour soak are excluded from this
  release's acceptance scope, as recorded in the project handoff. Neither is a pass.
- Physical audio-device unplug/replug and audible output recovery are excluded at
  the project owner's request. This release makes no claim of testing them.
- Prior clean-install/uninstall, npm-interruption recovery, real UAC refusal and
  virtual MIDI-driver recovery evidence is historical. The new installer changes
  received targeted ownership, trust, mutex and PowerShell checks; this is not a
  newly completed clean-machine lifecycle test of the final ZIP.
- New CAL arithmetic and template verification have deterministic regressions;
  this run did not execute all revised paths inside SONAR. The optional surface
  DLL was not newly installed into SONAR for COM-host validation.
- Earlier unexplained host exits remain unclassified; confirmed manual shutdowns
  are kept separate. Short smoke tests do not settle long-term stability.
- Disk-full/power-loss atomicity and concurrent external edits to SONAR's INI are
  not certified. Stop SONAR before changing its MIDI input configuration.
- Standard SDK argument-validation error formatting is retained. Abandoning a
  background job discards its result and does not cancel host work.

## Optional surface setup

Normal deployment does not need this component. For an intentional diagnostic
session, generate a token with the bundled Node crypto API, provide the same token
to the SONAR and MCP process environments **before launching them**, and enable
`CAKEWALK_MCP_SURFACE=1` only for that session. Keep the token out of version control
and logs. Without a valid token the native listener does not start. Authentication
does not re-enable retired memory or vtable operations.

## Upgrading

Stop the old MCP server, extract the new ZIP into a separate folder, run its
deployment script and update the MCP client to the new absolute path. Restart the
MCP client; an old running process does not reload new code. Keep your projects
and prior installation until the new doctor's expected channels are confirmed.
