# Third-party components

The adapter source is MIT licensed. Bundled components retain their own licenses.

- Node.js v24.20.0 (Windows x64): see `runtime/LICENSE` in the portable ZIP. Source license: https://github.com/nodejs/node/blob/v24.20.0/LICENSE.
- npm and its bundled dependencies: see `runtime/node_modules/npm/LICENSE` and the individual package license files.
- MCP SDK, Zod and their dependencies: versions and integrity hashes are recorded in `package-lock.json`; licenses are shipped with each package under `node_modules/` in the portable ZIP.
- loopMIDI 1.0.16.27: proprietary freeware by Tobias Erichsen. The unmodified installer is redistributed with the author's permission as recorded by the project owner in `vendor/loopMIDI/NOTICE.txt`. The adapter MIT license does not relicense loopMIDI.

The Git repository contains source and the lockfile. The portable release ZIP additionally contains the Windows runtime, dependencies and vendor installer.
