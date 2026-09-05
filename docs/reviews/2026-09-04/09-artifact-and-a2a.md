# S6 implementation handoff

Scope: approved v1 plan, owned worktree `/Users/laoyu/Documents/ChatGPT/voko-opt-boundaries-20260904`; Node 22.23.2/npm 11.19.0. No main-tree changes, production service, real Provider, credential database, release/publish, dependency install or full gate.

## R18 — implemented, pending independent review

Commit `292045f` changes only `.github/workflows/release-npm.yml`, `scripts/scan-package-secrets.js`, `test/lite-package-secret-scan.test.js`.

The release workflow scans the exact `.tgz` created once by `npm pack --ignore-scripts`, before upload. Publication continues to consume that uploaded artifact. The scanner reads one compressed snapshot and prints its SHA256 on success; source/build mutations after packing cannot change the scanned bytes. Existing source scanning and Gitleaks/CodeQL remain.

`--tarball` scans all valid UTF-8/UTF-16 BOM regular text members regardless filename suffix, including build, README, LICENSE and arbitrary text assets. Binary/nondecodable content is skipped. Match output is only rule/file/line, never matched values. System tar lists and extracts a private immutable expanded snapshot. Before extraction: package-only normalized relative paths, no parent/dot/absolute/backslash paths or duplicates; only directory/regular members, no links/devices; 64 MiB compressed, 256 MiB expanded/logical total, 10,000 members, 30 s per tar command/4 MiB list-output bounds. Extraction stays in a temporary private directory which is removed on completion/error. No new dependency or general archive framework.

Red: `node --test test/lite-package-secret-scan.test.js`: 12 tests, 10 failed/2 passed before implementation. Log `/tmp/voko-s6-artifact-red.log`.
Green same command: 12/12 pass. Log `/tmp/voko-s6-artifact-green.log`.
Tests cover built/README/extensionless/arbitrary-suffix text, exact snapshot/source exclusion, actual CLI failure without match-value output, binary/UTF16, traversal/absolute/symlink/hardlink/device rejection before any extraction, member/expansion limits.
Local integration: `npm pack --offline --ignore-scripts --json --pack-destination <owned temporary dir>` followed by `node scripts/scan-package-secrets.js --tarball <same file>` passed. Actual local artifact: 324 package members, 320 text files scanned, SHA256 `c4d73cde35ec7e5a9018b0d129dcbe0a63f5d90dcc6afbf591b597a03b891eea`; archive removed after scan. Log `/tmp/voko-s6-real-artifact-scan.log`. This is evidence for the owned tree at scan time, not a release artifact claim.
`git diff --check` passed. No Linux GNU tar/Windows run or real workflow executed; current macOS bsdtar exercised. GNU numeric-owner listing layout is supported in code but remains to be exercised by the integration/CI environment. Pattern scanner is heuristic and not proof that all possible secret encodings/types are absent.

## R19 — deferred_design, no product change

Actual store evidence: `src/a2a/task-store.ts:98` acceptCommand is INSERT OR IGNORE with task/sequence uniqueness; `:115` beginCommand checks only received status. `src/a2a/bridge-worker.ts:52` verifies the entire batch before persistence/ACK/execution. `src/a2a/bridge-runtime.ts:56` validates and verifies each Gateway signature. Mailbox claim associates eventId/taskId but no inspected signed batch-level relation proves which trusted task an invalid envelope belongs to. Per-agent serialization is not a predecessor-completion guard.

Probe `node /tmp/voko-s6-r19-boundary-probe.cjs` uses actual built SQLite store in a temporary database and actual worker with a synthetic verify callback. Passed: actual beginCommand accepts sequence 2 without any predecessor row; invalid item first/middle/last causes zero executions and zero ACKs for the batch. Log `/tmp/voko-s6-r19-boundary-probe.log`. Mock verification proves local worker ordering only, not cryptographic behavior or live Gateway exploitability.

Decision: preserve failure-closed behavior. Replacing map with individual catch cannot safely meet approved no-skip semantics using current guards. No scheduler, sequence state machine, fabricated success ACK or partial isolation added. Bad-item sustained-redelivery recovery remains unresolved and requires separate design/authorization.

## Separate S1 contract corrections

`eade306`: MCP IDs reject null/fractional values matching installed SDK; preserve id 0/empty string. 10-test red had 2 failures, then MCP suites 14/14 passed.
`608776f`: reject unsafe integer IDs with Number.isSafeInteger. Red 15 tests/3 failures, green request-ID plus MCP contract suites 19/19. Added MAX_SAFE/MIN_SAFE positive boundaries plus unsafe positives/negative/1e100 rejection without dispatch. Build:ts passed. Logs `/tmp/voko-boundary-mcp-safeinteger-{red,green,build}.log`.
These fixes arose from another agent's SDK review. No claim of independent review of my own S1/S6 code. Parent should cherry-pick S1 correction commits before S6.

Final owned status: only preexisting untracked docs/reviews and node_modules symlink; neither committed.

## Independent-review correction: filesystem aliases

Reviewer found an actual macOS false-negative in292045f: README.md with a synthetic secret followed by safe readme.md overwrote the first file during extraction, then both archive paths read safe content. Commit `a6f46a0` corrects this with NFC+lowercase path-collision rejection before extraction and final dev+ino uniqueness for every regular file before permitting success. The latter covers filesystem-specific aliases beyond simple lowercasing, without a general Unicode framework.

Red: 15 tests, 3 failures (case paths, canonically equivalent Unicode names, injected filesystem identity alias). Green:16/16 including a real APFS ß/ss collision test (on nonaliasing filesystems it instead requires the secret to be found). Logs `/tmp/voko-s6-collision-{red,green}.log`. Actual local pack rescanned successfully:324 members/320 text files; `/tmp/voko-s6-collision-realpack.log`. This correction is pending review by the original independent reviewer; no own independent-review claim.

## CodeQL review correction: descriptor reads and read-time budgets

Parent CodeQL reported two new filesystem-race findings (archive stat then path read; extracted lstat then path read). Commit `2ecbb0a` introduces one small readBoundedRegularFile helper: open O_RDONLY plus O_NOFOLLOW where available, fstat on that descriptor, require regular file, bounded64KiB readSync loop on the same descriptor, one overflow byte to detect growth, and finallyclose. Archive64MiB and aggregate extracted-member256MiB limits remain enforced during actual reads. The tar expansion256MiB/list/member guards remain. Accepted regular member names come from the validated tar inventory, so metadata directories are skipped without reopening/checking directory paths. Alias dev+ino checks use the same descriptor's fstat result.

Independent pre-review identified a new descriptor-open edge: O_RDONLY alone blocks on FIFO before fstat. Commit `732fbe9` adds O_NONBLOCK where available. Actual synthetic FIFO CLI test had a1.5s timeout on2ecbb0a and now immediately rejects nonregular file type. No type weakening/allowlist changes or generic framework.

Evidence: fd-boundary red21tests/4fail17pass, `/tmp/voko-s6-fd-read-red.log`; initial green25/25 including all prior16 tests, actual archive/member pathname replacement after inspection, growth beyond compressed/member budgets, archive/member symlink rejection, extracted directory rejection and fd close on success/failure. FIFO red26tests/1fail25pass `/tmp/voko-s6-fifo-red.log`; final green26/26 `/tmp/voko-s6-fd-read-green.log`. Platform-specific O_NOFOLLOW/FIFO tests explicitly skip where flags/POSIX fixtures unavailable; macOS run skipped0. Tests use actual files in owned temporary directories and hook inspection timing to force races; no production filesystem writes.

Actual npm pack/scan after2ecbb0a:324members/320text pass `/tmp/voko-s6-fd-read-realpack.log`. Changeset2ecbb0a+732fbe9 shared with independent reviewer. Root must confirm final integrated CodeQL result; local unit tests do not claim CodeQL findings cleared. No full gate or integration-tree changes here. Remaining same-UID concurrent in-place writer behavior is not an atomic immutable-file guarantee; reads enforce identity and bounds rather than claiming a new filesystem snapshot mechanism.
