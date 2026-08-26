# Registration friction fix list

Validated against `@voko/lite` 0.5.0. The executable reproductions live in
`test/registration-friction-reproduction.test.js`.

Implementation status: the P1/P2 registration and runtime items below are fixed
in the current working tree and covered by executable contract tests. The
platform and installer diagnostics remain follow-up improvements because they
are not registration-state-machine defects.

## P1: tool help is routed through the runtime

**Evidence:** `voko manage_agent_registration --help` is handled by the
registration-specific runtime branch before generic tool help. With no runtime,
it returns `RUNTIME_REQUIRED`; with a runtime, it is forwarded as an invalid MCP
request without `action`.

**Root cause:** the `manage_agent_registration` branch in `src/index.ts` precedes
the generic `voko <tool> --help` branch.

**Smallest fix:** handle known-tool help before any runtime-dependent command
routing. Help must not initialize Core, create a database, or require a running
runtime.

**Acceptance:** the help command exits 0, prints the `action` and
`registrationId` parameters, creates no database, and works while VOKO is
stopped.

## P1: missing registration ID leaks an internal TypeError

**Evidence:** `manage({ action: 'status' })` returns `REGISTRATION_ERROR` with
`Cannot read properties of undefined (reading 'id')`.

**Root cause:** `view(undefined)` treats its argument as a session object and
dereferences `session.id`. Required state-machine inputs are not validated at
the dispatch boundary.

**Smallest fix:** before dispatching every action other than `start` and the
sessionless form of `inspect_environment`, require a non-empty
`registrationId`. Return `REGISTRATION_ID_REQUIRED` without calling `view()` or
`_get()`.

**Acceptance:** all stateful actions share the same structured missing-ID error;
no JavaScript exception text is returned.

## P1: registration network failures are not classified

**Evidence:** `sendCode()` and `loginByCode()` catch fetch errors and return the
raw `Error.message`. Node commonly reduces DNS, connect, TLS, and timeout
failures to `fetch failed` at this layer.

**Smallest fix:** add one error-normalization helper that inspects the fetch
error and its `cause`, returning a stable code, stage, retryability, and bounded
diagnostic cause. Preserve server validation errors separately.

**Acceptance:** deterministic tests cover DNS failure, connect timeout, TLS
failure, HTTP failure, invalid code, and malformed response. Sending a code is
never automatically retried. Verification/login may only retry operations whose
server-side idempotency is established.

## P1: runtime startup has no explicit transitional result

**Evidence:** `probeRuntimeIdentity()` makes one request. An initial connection
failure becomes `RUNTIME_UNAVAILABLE`; identity differences become
`RUNTIME_MISMATCH`. Neither result exposes a safe expected/observed diagnostic,
and the probe does not distinguish startup from permanent failure.

**Smallest fix:** publish instance metadata only when it is internally
consistent, add a bounded startup probe with a short retry budget, and return
`RUNTIME_STARTING` while the recorded process is alive but health is not ready.
Do not retry a confirmed identity mismatch against a healthy endpoint.

**Acceptance:** a deterministic fake endpoint transitions from unavailable to
ready and succeeds within the retry budget; a different healthy instance fails
immediately with `RUNTIME_MISMATCH`; total wait remains bounded.

## P2: registration responses repeat the full environment

**Evidence:** `start()` stores a complete environment scan and `view()` includes
it in every response, including `status`. A small synthetic environment already
produces a response above 2 KB; real provider inventories can be much larger.

**Smallest fix:** make the default view stage-oriented and omit `environment`.
Keep the existing `inspect_environment` action as the explicit detailed view.
If compatibility requires a transition, support `includeEnvironment=true` for
one release before changing the default.

**Acceptance:** default `start`, `verify_email`, and `status` responses contain
only session identity, status, stage-relevant fields, and `nextAction`;
`inspect_environment` still returns the complete inventory.

## P2: caller-supplied human mode is silently downgraded

**Evidence:** an MCP caller that passes `registrationMode: 'human'` receives a
successful session whose mode is `agent`.

**Security constraint:** MCP and non-interactive CLI callers must not be able to
self-assert trusted human context. Web and interactive CLI remain the trusted
human entry points.

**Smallest fix:** either remove `registrationMode` from untrusted public input or
reject `human` from an untrusted caller with
`REGISTRATION_MODE_NOT_ALLOWED`. Do not honor the requested mode.

**Acceptance:** spoofed human mode is explicitly rejected; interactive CLI and
local Web still create human-mode sessions; agent mode remains unchanged.

## P2: owner authentication completion is not explicit in Agent registration

`voko login` already establishes owner identity independently, so this is not a
missing identity capability. The friction is that email verification inside the
Agent-registration state machine immediately reports provider selection without
an explicit owner-authenticated milestone.

**Smallest fix:** improve `nextAction`/UI copy to state that owner authentication
is complete and Agent creation may be resumed later. Do not split the state
machine unless a separate product requirement calls for owner-only signup.

## P2/P3: platform and installation diagnostics

- Extend setup/doctor output with `process.execPath`, resolved VOKO entry, npm
  prefix when available, and duplicate Node/npm/VOKO candidates. Redact broad
  local paths from normal human output when privacy requires it.
- Document `voko.cmd` for Windows automation where PowerShell execution policy
  blocks npm's `.ps1` shim. This is primarily platform behavior, not a VOKO
  runtime defect.
- Before self-update, detect a development symlink and provide an explicit
  migration message. After update, invoke the installed entry by its resolved
  path with `--version`. Prefer rollback over process-list heuristics for
  concurrent npm installations.

## Corrected test finding

The former test named “uses the detected current Provider instance without
asking the Agent to choose again” was invalid: it mocked `inspectCurrentAgent()`
while `start()` calls `inspectEnvironment()`, and it explicitly called
`selectProvider()` despite its title. The test now mocks the production boundary
and describes the behavior it actually verifies. This was a test regression,
not evidence that automatic instance selection currently exists.
