# Codex Provider 专属指南

Agent通过MCP收发消息时，先阅读[消息与精确Conversation接口契约](../mcp-message-conversations.md)：优先使用 `replyToMessageId`，按需使用VOKO `conversationId`，不要把Provider原生Session/thread ID当作VOKO会话ID。

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 **VOKO 调用 Codex CLI** 时的安装、登录、注册、会话恢复和安全边界。Codex 作为 MCP 客户端调用 VOKO 时，属于另一条方向，见本文的 MCP 小节。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人验证码或配置批准使用 Web/交互式注册。Codex 当前没有 VOKO ACP，接收消息选择 `CLI → Pull`；可选择 VOKO 检测到的 Codex Profile，但不要把 thread、会话文件或项目目录当作 Profile。

## 1. 安装和登录

在启动 VOKO 的同一个用户环境中确认：

```bash
codex --version
codex doctor
codex login status
```

当前本机实测 Codex CLI 0.145.0（Windows npm 安装）。如果未登录，使用 Codex 自身的登录流程：

```bash
codex login
```

登录凭证由 Codex 管理，不能写入 VOKO Agent 描述、delivery 配置或日志。修改 PATH、更新 Codex 或切换登录用户后，请完全重启 VOKO。

## 2. 注册时选择通道

在 VOKO 注册页面中：

1. Provider 选择 **Codex**。
2. 如果 `CODEX_HOME`（默认 `~/.codex`）存在 `<name>.config.toml`，VOKO 会把它显示为 Profile `<name>`。选择后，CLI 使用 `--profile <name>` 启动；Profile 是启动配置，不是 Codex thread/session。
3. 不要手工填写未检测到的 Profile，也不要使用 `config.toml`、项目目录、rollout 文件名或 thread ID 代替 Profile。未检测到命名 Profile 时仍可不绑定实例使用默认 Codex 配置。
4. 通道选择：

   ```text
   CLI → Pull
   ```

5. 完成后执行：

   ```bash
   voko doctor --deep
   voko status --json
   ```

VOKO → Codex 的 CLI 投递不要求在 Codex 中额外配置 VOKO MCP。只有 Codex 需要主动调用 VOKO 工具时，才配置 MCP 客户端。

## 3. VOKO 的 Codex 安全运行方式

VOKO 使用 Codex 的非交互 JSON 流模式，等价于：

```bash
codex exec --json --sandbox read-only --skip-git-repo-check -
```

后续消息使用 Codex 返回的原生 thread ID 恢复：

```text
codex --sandbox read-only exec resume <thread-id> --json --skip-git-repo-check -
```

VOKO 不使用 `--dangerously-bypass-approvals-and-sandbox`，也不会让访客消息直接执行 shell、网络请求、写文件或修改项目。不要为了“让 Codex 回复更快”手动替换成危险参数。

VOKO 默认从临时工作目录启动 Codex，不要求当前目录是 Git 仓库，也不会把 VOKO 的访客消息写入你的项目文件。

## 4. 会话和恢复

Codex 的原生 thread ID 会保存在 VOKO 的会话绑定中。绑定范围固定为：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

同一会话后续消息会使用同一个 thread ID；不同 Agent、不同访客、私聊和群聊不会共享 thread。不要从 Codex 的“最近会话”列表猜测并手动填入 VOKO。

Codex 的差异是原生 thread 删除/归档后的隔离会话处理；结果不明确、Pull 和跨通道行为按 [Transport 行为矩阵](../provider-transport-matrix.md) 执行。

Codex 没有 ACP 主通道；当 CLI 不可用时，消息保留在 Pull 中：

```text
voko_fetch_new_messages
```

## 5. Codex 作为 MCP 客户端

如果 Codex 需要调用 VOKO MCP，使用 Codex 自己的配置命令：

```bash
codex mcp add voko -- voko mcp
codex mcp list
```

配置文件通常位于：

```text
~/.codex/config.toml
```

如果已有旧的 VOKO HTTP、Desktop 或固定端口条目，先用 `codex mcp list` 检查，再移除旧条目并添加 stdio 条目；不要覆盖其他 MCP 服务器。此配置只影响 **Codex → VOKO MCP**，不改变 VOKO → Codex 的 CLI Provider 注册。

## 6. 常见问题

- `codex` 找不到：先在启动 VOKO 的同一终端执行 `codex --version`，确认 npm 全局 bin 在 PATH；然后重启 VOKO。
- 退出码为 1：先执行 `codex doctor` 和 `codex login status`，确认登录用户、模型额度、沙箱和安装一致性；不要先扩大沙箱权限。
- 首条消息较慢：首次 thread 创建需要启动 Codex 和模型调用，几十秒属于可能范围；不要因为等待而重复投递。
- 只有 Pull 没有 CLI：重新运行 `voko doctor --deep`，确认 VOKO 解析到当前 Codex 入口，并检查注册时是否启用了 CLI。
- 回复被截断或为空：确认使用 `--json` 非交互模式，并检查 Codex 版本；不要使用交互式 `codex` 主命令替代 VOKO 的 `codex exec`。
- MCP 工具为空：执行 `codex mcp list`，删除旧固定端口配置后重启 Codex，再使用 `voko mcp` stdio。

## 7. 本机验证边界

当前已在 Windows Codex CLI 0.145.0 上使用临时 VOKO 数据库完成真实验证：

- `codex exec --json` 首次投递和 JSONL 回复解析；
- 返回的原生 thread ID 保存到 VOKO 绑定；
- 第二条消息使用同一个 thread ID 恢复上下文；
- 只读沙箱、跳过 Git 仓库要求和临时工作目录生效。

其他 Codex 版本、登录方式、模型计划和企业策略仍需自行验收。不要提交 OAuth Token、`config.toml` 私密字段、thread ID、完整访客提示词或 Codex 输出中的账号信息。

## 8. Real MCP registration and acceptance (Windows, verified 2026-08-06)

This section records the real local path so a Codex user can follow the same flow without guessing which direction is being configured.

### Two independent directions

- **VOKO -> Codex**: VOKO invokes the local Codex CLI as a Provider. Register the Agent as `codex` with `CLI -> Pull`.
- **Codex -> VOKO**: Codex invokes VOKO tools through the MCP stdio bridge. This is optional and is configured separately with `codex mcp add voko -- voko mcp`.

Configuring the second direction does not change the first direction's Provider or session binding.

### MCP registration flow

1. Confirm the runtime and Codex login in the same user environment:

   ```bash
   voko start --no-open
   codex --version
   codex login status
   ```

2. Expose the VOKO MCP server to the Codex caller:

   ```bash
   codex mcp add voko -- voko mcp
   codex mcp list
   ```

   Codex CLI can discover the VOKO server as `mcp__voko__...`. A non-interactive `codex exec` may still ask for MCP approval; complete high-risk registration actions in an interactive Codex turn or through the same MCP state machine, and do not disable approvals globally.

### Caller identity for `whoami`

Codex exposes `CODEX_THREAD_ID` to Shell tool executions, but current Codex stdio MCP launches do not reliably inject it into the MCP child on Windows or macOS. On Linux, VOKO may use a bounded `/proc` parent-process check when it finds exactly one active Codex rollout file; restricted `/proc`, containers, and concurrent rollouts are treated as unavailable. VOKO does not run a model-guided or shell-command handshake. If `voko_whoami` returns `selection_required`, call `voko_list_agents`, ask the owner to choose, and retry with the selected `agentId`.

### MCP registration flow (continued)

3. Call `voko_manage_agent_registration` with `action=start` and `registrationMode=agent`. Keep the returned `registrationId` and follow every `nextAction` using that same ID. For a logged-in owner, continue with `set_basic_info`, `select_delivery`, `preflight_delivery`, and `complete`.

4. Use a clear name (for example, `tjyu的codex`), `providerType=codex`, and `deliveryModes=["cli","pull"]`. If VOKO returns detected Codex Profiles, select the intended `<name>.config.toml` profile; otherwise leave the instance empty. Codex has no ACP main channel, and a Profile must never be replaced with a thread ID, rollout filename, project path, or OpenClaw/Hermes instance ID.

5. If `nextAction.type` is `request_owner_email` or `submit_email_code`, pause and ask the owner. Never guess a mailbox or verification code, read an inbox, or retry a code send automatically.

### Real local acceptance

The current Windows installation was checked with Codex CLI `0.145.0` and an active ChatGPT login. A real MCP registration created a private Agent named `tjyu的codex` (Agent ID is kept in the local database), with:

- Provider: `codex`
- Delivery order: `CLI -> Pull`
- CLI preflight: ready
- ACP: not used
- Two real messages delivered through the current VOKO runtime and persisted as `sent`
- The second message reused the same active `codex-cli` native-session binding for the same Agent/visitor conversation

For a local smoke test, use a new visitor ID and an explicit confirmation. The command waits for the persisted outbound status and never resends an ambiguous message:

```bash
voko probe --agent-id <agent-id> --visitor-id codex-smoke-<date> --confirm --message "Reply exactly OK." --timeout 120
```

The first Codex turn can take tens of seconds while the CLI creates a native thread. A timeout is not proof that the message was lost; inspect `voko status --json` and the conversation before deciding whether to send anything else.

### Runtime and session rules

- VOKO uses non-interactive JSON output, read-only sandboxing, and a temporary working directory for Provider calls.
- VOKO stores the native Codex thread ID in a binding keyed by `(Agent, channel type, channel/visitor ID)`; do not copy a thread ID from Codex's recent-session list into VOKO.
- If the native thread is gone or cannot be resumed, VOKO creates one replacement session and does not duplicate a message whose delivery result is ambiguous.
- After changing PATH, login, or the installed Codex version, restart VOKO and rerun the preflight. If a newly registered Agent shows `Pull` only, restart the active runtime once so its Dispatcher route cache reloads the Agent.

### Troubleshooting checklist

```bash
codex --version
codex login status
voko doctor --deep
voko status --json
codex mcp list
```

- `codex` not found: fix the npm global bin directory in PATH for the account that starts VOKO, then restart VOKO.
- Exit code 1 or an empty reply: run `codex login status`, check the Codex account/model quota, and keep the read-only non-interactive invocation.
- `Pull` only: the CLI was not ready at registration or the running process has stale routing; rerun preflight after restarting VOKO.
- MCP tools missing: remove only the obsolete VOKO MCP entry, add the stdio entry above, and restart Codex. Do not paste tokens or private config values into an issue or log.

Logs and documents must contain only provider type, delivery mode, status, elapsed time, and redacted IDs. Never record access tokens, verification codes, full visitor prompts, native thread IDs, or private Codex configuration contents.

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 `codex-cli` 0.145.0。
- 使用 `codex login` 完成认证后，Voko 注册、只读 CLI 首条消息和同一访客续接均通过。
- 推荐接收通道：`CLI → Pull`；保持无交互、只读调用，不要把 Codex thread ID 写入文档或日志。
- 无图形 Linux 先在终端完成 `codex login`，再启动 Voko；若 PATH 或账号变化，重启 Voko 并重新运行 doctor。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
