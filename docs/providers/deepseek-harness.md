# DeepSeek Harness Provider

The HTTP adapter targets the public Remote contract checked against DSH
`c389f96bf3` (`0.1.3-alpha.2`). An identical package version alone is not proof
that a different build has the same contract.

## Connection

HTTP calls use slash-separated Remote endpoints with named `payload.args`.
Session snapshots use the public `/api/remote.mux` WebSocket; older records use
`session/page`. Replies are correlated with the client's persistent request ID,
not the outer HTTP RPC ID. Snapshot sockets are closed after their opening frame.

An existing Web Host requires its normal launch authentication URL. Supply it
privately as the HTTP Provider's `authUrl` option or `DSH_AUTH_URL` environment
variable. Its origin must exactly match the configured `baseUrl` (including
localhost versus 127.0.0.1). The adapter exchanges it for an in-memory cookie and
uses that cookie for HTTP and WebSocket requests. Do not put the URL in reports
or command history. Authentication is not disabled for loopback requests.

For an adapter-owned Host, startup uses `--profile web --port ... --no-open` and
privately captures its launch URL. A 401 from an existing Host does not trigger a
second Host. `cwd` sets the working directory for newly created sessions.

## Visitor target permission preset

The existing Agent permission page now exposes **DSH访客目标权限预设** for HTTP.
It is a target name, not a claim that underlying filesystem/network isolation has
been certified. Leave it empty to retain the deployment's defaults.

When configured:

1. Create a VOKO-dedicated session with the selected Agent preset and trusted cwd.
2. Discover `permission`, execute `/permission <name>`, check the business result,
   then read back `permissions.currentValue` before submitting visitor content.
3. Restore only compatible VOKO-managed sessions. Changed target/cwd/Agent preset,
   missing permission state or drift stops delivery; no Owner session is silently
   reconfigured. Enabling this on an old binding requires creating a new binding.
4. Refuse automatic CLI fallback and MCP `fetch_new_messages` consumption for this
   Agent while the target is configured. Existing messages remain stored.

Names are limited to 1–80 letters, digits, underscores or hyphens; `custom` is a
read-only derived state and cannot be selected. A deployment may redefine preset
semantics. The public permission projection advertises names, not a complete
sandbox/approval attestation. VOKO does not edit the shared default preset.

VOKO serializes its own calls for each session. Permission switching is still a
session operation, not an atomic per-message capability grant. Other trusted DSH
clients can modify that session. Drift is checked before submission and during
result observation; unknown accepted outcomes remain unknown and are not safe to
replay. A cancellation acknowledgement means admitted, not confirmed terminated;
DSH keeps the inbox, so VOKO does not report cancellation success on that receipt.

## CLI boundary

The existing CLI remains a one-shot fixed-profile adapter. It does not acquire the
HTTP target preset and cannot restore native HTTP sessions. No arbitrary patch
editor or new permission switches are introduced.

The checked DSH base bundle supports deployment environment
`DSH_PERMISSION_MODE=read-only`; its shipped read-only preset pairs that with
`ask`. This was checked on an isolated headless invocation. Profile overrides can
change behavior, so this is not sufficient evidence to enable HTTP-policy fallback.

## Validation performed

- Build passed; 51 focused Provider/security/Web/MCP/catalog tests passed (the group MCP suite additionally runs 50 assertions internally).
- Real isolated Web Host: authentication, preset discovery, session creation,
  command execution, permission snapshot and actual model reply via the adapter.
- Synthetic bash write under read-only: OS denied the write; target absent.
- Equivalent workspace-write task: target created.
- Isolated headless read-only profile: write denied; target absent.
- Adapter-owned isolated Host startup/authentication checked.
- Host restart preserved read-only state; externally changing that test session to
  workspace-write caused the Provider to reject recovery with zero prompt calls.
- A real escalation request waited for approval. At the Provider deadline the
  outcome remained unknown, cancellation was requested, DSH logged cancelled
  approval, and the synthetic target file remained absent.

These are Provider-to-DSH checks, not a claim that a production IM visitor journey
or all possible tools/plugins were tested. No DSH plugin/core change is required.

## Real local Dispatcher regression

After building, run `node scripts/real-dsh-provider.js` using the Node version
supported by the installed DSH build and its configured model credentials. It
starts an isolated real DSH Host, uses a real VOKO SQLite database and Dispatcher,
and checks policy leases, persisted session bindings, returned replies, actual
sandbox denial/allowed writes, and recovery rejection after permission drift.
The private temporary directory contains a JSON report and test-only data.
The Host is stopped in the cleanup path. This test consumes real model calls.

The ingress uses synthetic visitor identities; it does not register an account,
change the running Lite instance, or send a public IM message. It therefore tests
the local execution chain, not the cloud IM transport.
