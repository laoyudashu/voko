# Uninstall VOKO Lite

[Documentation index](README.md) · [中文](uninstall.md) · [日本語](uninstall.ja.md)

`voko uninstall` reuses the identity-validated `voko stop` lifecycle, stops matching VOKO workers, inventories MCP and Provider configuration references, and prints the appropriate npm removal command. It does not invoke npm, stop Provider services, or edit third-party configuration. Repeated use and an already-stopped runtime are successful no-ops.

```bash
voko uninstall                 # prepare removal and preserve data
voko uninstall --dry-run       # preview without stopping or deleting
voko uninstall --json          # machine-readable output
```

Local data and `voko.db` are preserved by default for a later reinstall. The default directory is `%APPDATA%\voko` on Windows, `~/Library/Application Support/voko` on macOS, and `$XDG_CONFIG_HOME/voko` or `~/.config/voko` on Linux.

Use `voko uninstall --purge` for permanent local deletion and type `DELETE VOKO DATA`. Non-interactive automation must explicitly use `voko uninstall --purge --yes`. Custom `--db` and `VOKO_DB_PATH` locations, roots, home directories, symbolic links, junctions, and ambiguous targets are never deleted automatically.

Only MCP entries that explicitly reference VOKO and Provider locations that may have been involved in OpenClaw / Hermes setup are reported. Configuration bodies, tokens, and secrets are never printed; review the reported locations manually.

AgentDID accounts, remote Agents, server messages, allowlists, and other cloud access-control data are not removed and require their separate remote management flows.
