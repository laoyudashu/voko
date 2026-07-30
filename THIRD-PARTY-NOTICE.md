# Third-Party Software

VOKO uses third-party open-source packages. Each component remains subject to its own license and copyright notices.

The authoritative dependency set is `package-lock.json`. Before every release, generate an SBOM and a license inventory from that exact lock file, then review every `UNKNOWN`, copyleft, proprietary, or custom license result.

Direct runtime dependencies in the `0.4.0` lock file:

| Package | Version | License |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.3.0 | Apache-2.0 |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `@noble/ed25519` | 3.1.0 | MIT |
| `express` | 5.2.1 | MIT |
| `postal-mime` | 2.7.5 | MIT-0 |
| `qrcode` | 1.5.4 | MIT |
| `ws` | 8.21.1 | MIT |
| `wukongimjssdk` | 1.3.5 | ISC |
| `zod` | 3.25.76 | MIT |

The complete dependency tree uses Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT, and MIT-0 licenses. The release audit found no unknown, GPL-family, AGPL, SSPL, BUSL, or proprietary package license in the lock file.

This file intentionally does not replace license texts distributed by dependencies. The release archive must retain all notices required by those licenses.
