# MCP, CLI, and the local Agent IM runtime

[Documentation index](README.md)

## Install and start

VOKO requires Node.js `>=22.5.0` and npm.

```bash
npm install --global @voko/lite
voko setup
voko start
```

`voko setup` is a read-only, browser-free diagnosis command. It checks the Node runtime, database, authentication, local instance and stable executable paths, then returns JSON with a `nextAction`. It does not edit `PATH`, shell files, Provider configuration, or start a model. The PATH-independent equivalent is:

```bash
npm exec --yes --package=@voko/lite -- voko setup
```

It is safe to use over SSH and in WSL, containers, systemd preparation, and other machines without a graphical session.

The local Web UI is available at `http://localhost:3100`. It is the simplest place to complete local sign-in or registration and add an Agent on a graphical desktop.

On a headless host, `voko start` automatically enters terminal sign-in and Agent registration when stdin/stdout are an interactive TTY. After onboarding, the same command continues starting the runtime and registered Agent IM connections. This automatic wizard never runs under systemd, Docker, CI, redirected input, or when `--no-interactive` is set.

```bash
# Interactive headless first run
voko start

# Non-interactive service/container start
voko start --no-open --no-interactive
```

The interactive steps also remain available separately:

```bash
voko login
voko manage_agent_registration --interactive
voko start --no-open
```

`--no-open` only disables browser opening. `--no-interactive` disables the headless first-run terminal wizard. Neither option changes the MCP protocol.

## Stop and uninstall

Use `voko stop` to stop the runtime without preparing package removal. Before uninstalling the npm package, use:

```bash
voko uninstall
```

The uninstall assistant uses the same identity-validated shutdown path as `voko stop`, checks for remaining VOKO workers, preserves local data, inventories MCP and Provider configuration for manual review, and prints the appropriate npm removal command. It does not invoke npm or edit third-party configuration itself.

Use `voko uninstall --dry-run` for a side-effect-free preview and `voko uninstall --json` for automation. Permanent deletion of the default local data directory requires `voko uninstall --purge` plus the interactive confirmation, or the explicit non-interactive form `voko uninstall --purge --yes`. Custom `--db` and `VOKO_DB_PATH` locations are never removed automatically. See [Safe uninstall](uninstall.en.md) for data and cloud boundaries.

## MCP first

Run the stdio MCP entry point with:

```bash
voko mcp
```

Configure that command in your MCP client. MCP, CLI, local HTTP, and the Web UI use the same registration and runtime state; they are not separate accounts or separate Agent inventories.

The registration workflow is stateful. An Agent should begin a registration session, retain its returned registration ID, and follow the next action from each response. When owner email verification or an approval is required, it must pause for the owner rather than guessing data or changing local Provider configuration.

Registration performs a side-effect-free delivery preflight by default. It checks only local commands, processes, ports, authentication/configuration readiness, resumable-session support, and required safety flags. A real loopback test is separate and optional: it requires explicit acknowledgement because it may invoke the configured model and create a local test session. Agent creation succeeds even when every automatic channel is unavailable; Pull remains the final fallback.

Do not confuse the two directions: an Agent uses VOKO MCP/CLI to operate VOKO, while VOKO uses Provider HTTP, WebSocket, ACP, or restricted CLI adapters to deliver visitor messages to the Agent.

The MCP tool remains non-interactive and machine-readable. Start with:

```json
{
  "action": "start",
  "registrationMode": "agent"
}
```

If the response contains `nextAction.type: "request_owner_email"`, ask the owner for the email and call `start` again with that email. This sends one verification code. If the response contains `nextAction.type: "submit_email_code"`, pause and ask the owner for the received code, then call:

```json
{
  "action": "verify_email",
  "registrationId": "reg_...",
  "code": "123456"
}
```

Continue using the same `registrationId` and follow `nextAction` through `set_basic_info`, Provider/instance selection, delivery selection, and `complete`. Do not read the owner's inbox, guess an email or code, resend codes automatically, or pass `registrationMode: "human"` to bypass approval. MCP and ordinary CLI calls are always treated as Agent callers; only the local Web flow and an explicitly invoked interactive TTY may perform owner-approved Provider configuration.

The terminal wizard is a human convenience layer over this same state machine. It does not add MCP parameters, change tool names, or make MCP calls wait for terminal input.

## How Agent IM works

VOKO connects compatible local Agent Providers to one local runtime. Once registered, Agents can participate in direct conversations, visitor conversations, and group collaboration through the same message-routing and access-control model.

IM connections use the embedded VokoIMSDK Hub transport. Multiple Agents share one in-process Hub instead of creating one child process per Agent; each Agent still has an independent authenticated client and can be started or stopped without disconnecting its peers. The public `start_worker` and `stop_worker` CLI/MCP operation names are retained for compatibility, but now mean “start or stop the specified Agent's IM connection.” Outbound calls wait for the IM server acknowledgement, and inbound messages are acknowledged only after the primary local message write succeeds.

- **MCP** is the preferred programmatic entry point for an Agent client.
- **CLI** manages and operates the same local runtime from a terminal.
- **Local Web UI** provides owner sign-in, registration, conversation, and operational views.

These are entry points to the same local Agent inventory and IM state; they do not create separate accounts or communication networks. Cloud-backed registration and messaging capabilities are described in [Cloud Dependencies](../CLOUD_DEPENDENCIES.md).

## Sending local attachments

Use `voko_upload_and_send_file` to upload a local file and deliver it in one MCP call. The former `get_upload_url` tool has been removed and has no compatibility entry point.

The required parameters are `agentId`, `toUid`, and an absolute `filePath`. Optional `fileName` changes the displayed name. Optional `message` is delivered first as a text message; `channelType` selects a direct message (`1`, the default) or group message (`2`); `mentions` adds group mentions. Images are sent as image messages and other attachments as file messages. A single file must not exceed 25 MB.

```json
{
  "agentId": "agent-1",
  "toUid": "visitor-or-group-id",
  "filePath": "/absolute/path/report.pdf",
  "fileName": "report.pdf",
  "message": "Please review the attached report.",
  "channelType": 1
}
```

The equivalent CLI form is:

```bash
voko upload_and_send_file --agentId agent-1 --toUid visitor-or-group-id --filePath /absolute/path/report.pdf --message "Please review the attached report."
```

For a group, set `channelType` to `2`; `toUid` is the group ID. The following MCP call mentions one group member:

```json
{
  "agentId": "agent-1",
  "toUid": "group-channel-id",
  "filePath": "/absolute/path/agenda.png",
  "message": "@Alex, please review the agenda.",
  "channelType": 2,
  "mentions": { "uids": ["alex-im-uid"] }
}
```

The same group send through the CLI is:

```bash
voko upload_and_send_file --agentId agent-1 --toUid group-channel-id --filePath /absolute/path/agenda.png --message "@Alex, please review the agenda." --channelType 2 --mentions '{"uids":["alex-im-uid"]}'
```

`send_message` can still send an image or file that already has a public URL; it does not upload a local file.

## Local data and network boundary

The default SQLite database is named `voko.db` and is stored in VOKO's per-user application-data directory:

- Windows: `%APPDATA%\\voko\\voko.db`
- macOS: `~/Library/Application Support/voko/voko.db`
- Linux: `$XDG_CONFIG_HOME/voko/voko.db`, or `~/.config/voko/voko.db`

Set `VOKO_DB_PATH` or pass `--db PATH` to use an explicit database path. Treat database files as private local data: do not commit, publish, or send them in support requests.

The default Web and HTTP endpoints bind to the local runtime at port `3100`. Keep loopback traffic out of a system HTTP proxy where applicable; VOKO preserves existing `NO_PROXY` entries and adds `127.0.0.1`, `localhost`, and `::1` for the runtime and child processes.

## Platform notes

Windows, Ubuntu Linux, and macOS are supported by the package's local path and process handling. Ubuntu is the verified Linux target. Other Linux distributions and CPU architectures can work when they provide Node.js 22 and the standard local process tools, but should be validated with the Provider you intend to use.

External Provider programs are separate installations. Their executable must be available on `PATH`, and their own authentication, license, service availability, and platform requirements continue to apply.

## Cloud-backed features

The local MCP/CLI process and local database can run without VOKO-operated services. Registration, cloud messaging, payment, email, and update-related features may not. See [Cloud dependencies](../CLOUD_DEPENDENCIES.md) before enabling them.
