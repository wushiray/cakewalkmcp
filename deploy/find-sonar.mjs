// Share runtime discovery with the installer (including registry and D: installs).
import { findSonar } from '../lib/sonar.js';
console.log(JSON.stringify({ path: findSonar() }));
