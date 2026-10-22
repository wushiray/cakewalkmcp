// deploy/sonar-state.mjs — one JSON line describing SONAR's run/sign-in state.
//
// Exists as a file rather than an inline `node -e` in install.ps1: the query
// needs arrow functions and quotes, and the installer already carries three
// levels of escaping. A file has no quoting layer to get wrong.
//
// Why the sign-in state matters: measured on a clean install, an unactivated
// SONAR exposes 52 accessibility elements and NONE of the "<label> on Track N"
// controls, while the same window after signing in exposes 402. So the
// click-based track tools (mute / solo / arm / rename) fail until SONAR has been
// signed in once. The installer cannot sign in for the user, but it can say so.
import { documentState } from '../lib/track-ui.js';

try {
  const d = await documentState();
  const title = d.title || '';
  // SONAR appends its activation state to the caption, e.g.
  // "Cakewalk Sonar [未激活]" or "Cakewalk Sonar - [song.cwp] [Not Activated]".
  const notActivated = /\[(?:未激活|not\s+activated)\]/i.test(title);
  console.log(JSON.stringify({
    known: Boolean(d.known),
    projectOpen: Boolean(d.projectOpen),
    title,
    signedIn: d.known ? !notActivated : null,
  }));
} catch (e) {
  console.log(JSON.stringify({ known: false, error: e.message }));
}
// The bridge is a long-lived child; its pipes keep node alive after the print.
process.exit(0);
