# Connect MCP clients to VOKO

[Documentation index](README.md) · [中文](mcp-client-setup.md)

This guide connects MCP clients such as WorkBuddy and Qwen Code to the local VOKO runtime. They can then use VOKO MCP tools for Agent registration, conversations, messages, and groups.

> This differs from VOKO invoking a Provider CLI. This page configures an Agent application as an **MCP client** of VOKO. To use Qwen Code as a VOKO Provider, add Qwen Code in the Web UI and make sure `qwen` is installed, signed in, and on `PATH`; no VOKO MCP entry is required in Qwen Code for that Provider workflow.

## Start VOKO first

Keep the local runtime running before starting the MCP client:

```bash
voko start
```

For a browser-free installation diagnosis, run `voko setup`. It returns JSON and never opens a page or modifies PATH, shell files, or Provider configuration. If `voko` is not on PATH, use `npm exec --yes --package=@voko/lite -- voko setup`.

For an existing installation, run `voko doctor` when you need to troubleshoot runtime health. It reads the database, Agent, IM/delivery capability, and local health state without starting a Provider or model. Use `--json` for scripts and `--deep` to probe configured API, IM, OSS, and local CLI/ACP paths. Exit code `0` means all checks passed, `1` means warnings, and `2` means a required check failed.

If a client still has an unambiguous legacy VOKO URL entry, run `voko doctor --fix-mcp` to migrate only that VOKO entry to `command: voko` with `args: [mcp]`. A sibling `.voko-mcp.bak` backup is created before each change; unrelated MCP servers are preserved. Review the report and fully restart the client. The migration is explicit and is not performed during `voko start`.

Every configuration below launches this stdio command:

```bash
voko mcp
```

### Real delivery probe

To verify one configured Provider through the local gateway and persistence path, run:

```bash
voko probe --agent-id <agentId> --visitor-id <visitorId> --confirm
```

This can invoke the model and send a real IM reply to the supplied visitor. The confirmation flag is mandatory. Add `--message "..."` or `--timeout 30` as needed. If the command returns `PROBE_TIMEOUT`, investigate the original delivery before sending another probe.

Do not put a fixed `localhost` port in the client. Prefer the `voko mcp` stdio command: the proxy discovers the active local port and short-lived local authentication information, so the client configuration survives a port change.

Use HTTP only for a client that cannot launch stdio. Run `voko start --no-open` and `voko status --json`, read the top-level `port`, and configure `http://localhost:<port>/mcp`. Port `3100` is the default only, not a fixed contract. If an old Desktop entry or `localhost:3002` / `localhost:3100` URL remains, replace it with stdio when possible, save the change, fully exit, and restart the client.

## WorkBuddy

Some WorkBuddy versions display the entry as **CodeBuddy Settings**.

1. In the WorkBuddy conversation panel, open **CodeBuddy Settings**.
2. Select **MCP**, then select **Add MCP**.
3. Keep existing servers and add the following entry inside `mcpServers`. If the file is empty, paste the complete JSON.

```json
{
  "mcpServers": {
    "voko": {
      "type": "stdio",
      "command": "voko",
      "args": ["mcp"],
      "description": "VOKO local Agent IM"
    }
  }
}
```

4. Select **Try to Run**, save the configuration, and start a new WorkBuddy session.

If there is no MCP settings page, edit:

- Windows: `%USERPROFILE%\\.workbuddy\\mcp.json`
- macOS / Linux: `~/.workbuddy/mcp.json`

When other servers already exist, copy only the `"voko": { ... }` entry rather than overwriting the file. This section makes WorkBuddy an MCP client of VOKO; it does not claim WorkBuddy as a verified VOKO Provider runtime.

## Goose

Prefer a stdio extension so Goose launches the current installed `voko mcp` command. Add this entry under Goose's `extensions` configuration:

```yaml
extensions:
  voko:
    enabled: true
    name: voko
    description: VOKO MCP tools
    display_name: VOKO MCP
    type: stdio
    cmd: voko
    args: [mcp]
    timeout: 300
```

You can also enable it for one session with `goose session --with-extension "voko mcp"`. Do not point `url` at an old Desktop port. After changing the configuration, fully exit and restart Goose, then verify with `tools/list`.

This section configures Goose as an **MCP client** of VOKO. If VOKO should invoke Goose as a Provider, see the [Goose Provider guide](providers/goose.md) for CLI/ACP registration, native session IDs, fallback, and recovery.

## Claude Code

When Claude Code is the MCP client, add VOKO with Claude Code's own configuration command:

```powershell
claude mcp add voko -- voko mcp
claude mcp list
```

This configures **Claude Code → VOKO MCP** only. To have VOKO invoke Claude Code, see the [Claude Code Provider guide](providers/claude-code.md) and register `claude-code` with `CLI → Pull`; the two directions have independent login, permission, and session-binding rules.

## Qwen Code

### Fast path: add from the CLI

```bash
qwen mcp add --scope user voko voko mcp
```

Then start or restart Qwen Code:

```bash
qwen
```

Run `/mcp` inside Qwen Code and confirm that `voko` is listed.

### Manual path: edit settings.json

Open:

- Windows: `%USERPROFILE%\\.qwen\\settings.json`
- macOS / Linux: `~/.qwen/settings.json`

For an empty file, paste:

```json
{
  "mcpServers": {
    "voko": {
      "command": "voko",
      "args": ["mcp"]
    }
  }
}
```

When `mcpServers` already exists, add only:

```json
"voko": {
  "command": "voko",
  "args": ["mcp"]
}
```

Restart Qwen Code and use `/mcp` to check it. User-level configuration is normally preferable; project-level configuration is stored in `.qwen/settings.json`.

## Other stdio MCP clients

For a JSON configuration page or an `mcpServers` file, use:

```json
{
  "mcpServers": {
    "voko": {
      "command": "voko",
      "args": ["mcp"]
    }
  }
}
```

Add `"type": "stdio"` if the client requires an explicit transport. If it cannot find `voko`, run `voko --version` in a system terminal. Reinstall `@voko/lite` or add npm's global bin directory to `PATH`, then fully restart the client.

## Troubleshooting

1. **No running Lite instance**: run `voko start`. On a graphical desktop, run `voko status --json` after startup to get the current Web UI port; 3100 is only the default. An interactive headless terminal automatically starts email sign-in and Agent registration. For systemd, Docker, CI, or another non-TTY environment, first run `voko login` and `voko manage_agent_registration --interactive` in a terminal, then start the service with `voko start --no-open --no-interactive`.
2. **Client cannot find `voko`**: run `voko --version` in a system terminal. Reinstall `@voko/lite` or use the absolute path to `voko` in the MCP setting, then fully exit and restart the client so it inherits `PATH`.
3. **Tools are empty or come from an old instance**: run `voko status --json` and check `running`, `instanceId`, top-level `port`, and `version`; use `voko mcp` and have the client repeat `tools/list`. Do not guess or hard-code 3002/3100. Remove stale Desktop/HTTP entries, switch to stdio, and restart the client.
4. **Registration succeeded but messages do not arrive**: registration does not prove that the IM Worker is connected. Use the MCP tool `voko_get_status` or CLI `voko get_status --agent-id=<agentId>` and inspect `imConnection.connected/status`. Keep the Agent → VOKO MCP/CLI direction separate from the VOKO → Provider delivery direction.
5. **Obsolete registration interface**: `voko_register_agent` and `voko_verify_agent_email` have been removed. Use the non-interactive `voko_manage_agent_registration` state machine, retain its `registrationId`, and follow each `nextAction`. Pause for the owner when email, a verification code, or Provider-configuration approval is required. The automatic headless CLI wizard does not change the MCP schema and never makes `voko mcp` read terminal input. Do not run a short-lived registration process from a `voko-desktop` checkout to bypass the current Lite runtime.
6. **Never copy a Token**: this configuration does not need a VOKO Token, email code, password, or Agent private key.

For Qwen Code syntax, refer to the [official Qwen Code MCP documentation](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md). WorkBuddy UI labels can vary by version; the configuration-file path is a fallback.
