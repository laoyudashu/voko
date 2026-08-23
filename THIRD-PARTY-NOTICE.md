# Third-Party Software

VOKO uses third-party open-source packages. Each component remains subject to its own license and copyright notices.

The VOKO project code is licensed separately under GNU AGPL v3.0-only. The dependency licenses listed below apply only to their respective components.

The authoritative dependency set is `package-lock.json`. Before every release, generate an SBOM and a license inventory from that exact lock file, then review every `UNKNOWN`, copyleft, proprietary, or custom license result.

Direct runtime dependencies in the `0.4.0` lock file:

| Package | Version | License |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.3.0 | Apache-2.0 |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `@noble/ed25519` | 3.1.0 | MIT |
| `curve25519-js` | 0.0.4 | MIT |
| `crypto-js` | 4.2.0 | MIT |
| `express` | 5.2.1 | MIT |
| `md5-typescript` | 1.0.5 | ISC |
| `postal-mime` | 2.7.5 | MIT-0 |
| `qrcode` | 1.5.4 | MIT |
| `ws` | 8.21.1 | MIT |
| `zod` | 3.25.76 | MIT |

The complete dependency tree uses Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT, and MIT-0 licenses. The release audit found no unknown, GPL-family, AGPL, SSPL, BUSL, or proprietary package license in the lock file.

The E2EE WebAssembly core under `e2ee/` has a separate authoritative Rust dependency set in `e2ee/Cargo.lock`. Release license and SBOM checks must include that lock file as well as the npm lock file.

This file intentionally does not replace license texts distributed by dependencies. The release archive must retain all notices required by those licenses.
