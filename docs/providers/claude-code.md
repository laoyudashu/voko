# Claude Code Provider 专属指南

Agent通过MCP收发消息时，先阅读[消息与精确Conversation接口契约](../mcp-message-conversations.md)：优先使用 `replyToMessageId`，按需使用VOKO `conversationId`，不要把Provider原生Session/thread ID当作VOKO会话ID。

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 **VOKO 调用本机 Claude Code CLI** 时的安装、登录、注册、会话恢复和排障。Claude Code 作为 MCP 客户端调用 VOKO 时，属于另一条独立方向，见第 5 节。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人验证码或配置批准使用 Web/交互式注册。Claude Code 当前没有 VOKO ACP，接收消息选择 `CLI → Pull`；不要把本地路径或 session 文件名当作 Provider Instance。

## 1. 安装、版本和登录

在启动 VOKO 的同一个 Windows 用户环境中确认入口：

```powershell
claude --version
claude auth status
```

当前已在 Windows 实机验证 Claude Code `2.1.220`。如果尚未安装，请按 Claude Code 官方安装方式安装；npm 安装环境通常可以使用：

```powershell
npm install -g @anthropic-ai/claude-code
```

如果尚未登录，在交互式终端完成 Claude Code 自身的登录流程，然后再次执行 `claude auth status`。不要把 OAuth Token、`ANTHROPIC_API_KEY` 或完整认证输出写入 VOKO Agent 描述、提交记录或日志。

安装、登录或 PATH 发生变化后，完全重启 VOKO，让 Provider 重新解析入口：

```powershell
voko stop
voko start --no-open
voko doctor --deep
```

## 2. 注册 VOKO Agent

这里配置的是 **VOKO → Claude Code**，不是 Claude Code 的 MCP 配置：

1. 在 VOKO 注册流程中选择 Provider 类型 `claude-code`。
2. 使用当前 VOKO 主人邮箱完成归属；需要验证码时只在交互终端或 Web 流程中手工输入。
3. 选择投递顺序：

   ```text
   CLI → Pull
   ```

4. 完成注册后检查：

   ```powershell
   voko doctor --deep
   voko status --json
   ```

Claude Code 当前没有 VOKO ACP 主通道，也不需要填写 OpenClaw Agent ID、Hermes profile 或其他 Provider Instance。`backend_instance_id` 保持为空；不要把 Claude 的本地路径或会话文件名当成 Instance。

如果注册时只有 Pull：先确认 `claude --version` 和 `claude auth status`，再重启 VOKO。新 Agent 加入已运行的旧进程时，旧 Dispatcher 路由缓存可能尚未包含 CLI 状态。

## 3. VOKO 的安全 CLI 运行方式

VOKO 使用非交互的 stream JSON 调用 Claude Code，提示词经 stdin 传递，不把访客内容拼进命令行参数。托管调用包含以下限制：

- `--permission-mode plan`；
- `--bare`、`--safe-mode`；
- `--tools=`，不开放工具调用；
- `--strict-mcp-config`，不继承任意项目 MCP 配置；
- `--no-chrome`、`--disable-slash-commands`；
- 工作目录为系统临时目录，不加载 VOKO 项目的 `CLAUDE.md` 或修改项目文件。

因此，VOKO 中的 Claude Agent 适合对话、分析和计划回复，不应被当作可以替访客执行 shell、写文件、浏览器操作或提交代码的自动化执行器。不要为了“让回复更快”手动替换为 `--dangerously-skip-permissions`、`bypassPermissions` 或重新开放工具。

## 4. 会话连续性和 Pull 兜底

### Caller identity for `whoami`

Current Claude Code releases pass `CLAUDE_CODE_SESSION_ID` to stdio MCP servers, matching the value available to hooks and Bash. VOKO uses that value as trusted caller evidence on Linux, Windows, and macOS; it is not a Provider instance identifier. Restart Claude Code after upgrading or changing MCP configuration. If an older release does not pass the variable, VOKO returns explicit Agent selection instead of starting a slow handshake or guessing a session.

Claude CLI 返回的原生 `session_id` 会保存到 VOKO 的会话绑定中。绑定键固定为：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

首条消息创建托管 session，后续同一会话使用 `--resume <session_id>`；不同 Agent、不同访客、私聊和群聊不会共享 session。不要从 Claude 的会话列表猜测并手工填入 VOKO。

当前 Provider 已显式把 `claude-code` 的 binding 映射到 `claude-cli`，因此重启 VOKO 或连续投递不会因为 Provider 名称差异而误创建新会话。若原生 session 被删除、清理或无法恢复，VOKO 会将旧绑定标记为 stale，创建一次新的隔离 session；结果不明确时不会自动重复发送同一条消息。

按 [Transport 行为矩阵](../provider-transport-matrix.md) 的 Pull/恢复规则处理 CLI 不可用或进程健康检查失败；Claude Code 侧只需确认 `voko_fetch_new_messages` 能读取待处理消息，并在恢复入口后重新运行预检。

## 5. Claude Code 作为 MCP 客户端（可选）

如果希望 **Claude Code → VOKO** 主动调用 VOKO 工具，使用 Claude Code 自己的 MCP 配置：

```powershell
claude mcp add voko -- voko mcp
claude mcp list
```

这条配置只影响 Claude Code 调用 VOKO MCP，不会改变 VOKO → Claude Code 的 Provider、投递顺序或会话绑定。VOKO 托管调用带有 `--strict-mcp-config` 和 `--tools=`，不会自动加载这条 MCP 配置作为访客工具权限。

## 6. 最小真机验收

使用新的访客 ID 和显式确认执行一次真实投递：

```powershell
voko probe --agent-id <agent-id> --visitor-id claude-smoke-<date> --confirm --message "Reply exactly OK." --timeout 120
```

期望结果：

- 返回 `success: true`、`code: PROBE_OK`；
- VOKO 中出站回复状态为 `sent`；
- 同一个访客再次 probe 时，绑定的原生 `session_id` 不变；
- 日志只记录状态、耗时、消息长度或脱敏标识，不记录 Token、完整访客提示词、原生 session ID 或本地配置路径。

当前 Windows 实机验收（2026-08-06）：

- Claude Code `2.1.220`，已登录；
- 通过 VOKO MCP 注册了私有 `claude-code` Agent，名称为 `tjyu的Claude Code`；
- 注册预检确认 CLI 可用，通道为 `CLI → Pull`；
- 新访客首条和续接消息均真实返回 `OK`，出站消息状态均为 `sent`；
- 读取本地绑定和 Claude session 文件确认，同一访客的两条消息复用了同一个原生 session；
- 未发现 Token、完整提示词或认证内容进入 VOKO 运行日志。

真实验收只代表当前 Windows、Claude Code 版本、登录方式和模型配置。切换账户、升级 CLI、清理 `~/.claude/projects` 或更换运行用户后，应重新执行预检和连续消息测试。

## 7. 常见问题

- **`claude` 找不到**：在启动 VOKO 的同一终端执行 `where.exe claude`、`claude --version`，修复用户 PATH 后重启 VOKO。
- **认证失败或 401/403**：执行 `claude auth status`，在交互终端完成 Claude Code 登录；不要把 Token 复制到 VOKO 配置。
- **注册后只有 Pull**：执行 `voko doctor --deep`，确认 CLI 预检通过；重启已运行的 VOKO 以刷新 Dispatcher 路由缓存。
- **连续消息创建了新 session**：确认使用包含 Claude binding 兼容修复的 VOKO 版本；不要手工复制 session ID。若 Claude 原生 session 已不存在，创建一次新 session 属于预期行为。
- **探针超时**：不要立即重复发送；先查看 `voko status --json` 和会话记录。探针不会对结果不明确的消息自动重投。
- **Claude Code 能调用 VOKO，但 VOKO 推不进 Claude**：这是两个方向，分别检查 `claude mcp list` 与 VOKO Agent 的 CLI 预检、登录状态和投递模式。

问题报告只提交脱敏信息：VOKO 版本、操作系统、Claude Code 版本、Provider 模式、耗时和错误类别。不要提交认证输出、Token、原生 session ID、完整访客消息或 `.claude` 私密配置。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 Claude Code 2.1.220。
- 使用同一 Linux 用户完成登录、Voko 注册、首条消息和同一访客续接；结果均通过。
- 推荐接收通道：`CLI → Pull`。启动 Voko 的 shell 必须能读取与交互式 `claude` 相同的登录状态。
- Linux 排障优先运行 `claude auth status`、`voko doctor --deep`，修复 PATH/认证后重启 Voko 刷新路由。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
