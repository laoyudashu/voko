# ZeroClaw Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 VOKO 调用 ZeroClaw 的配置、Agent alias、ACP、CLI 降级和会话隔离。ZeroClaw 的 **Agent alias、运行进程和原生 session 不是同一个概念**：本次 `backend_instance_id` 只保存用户选择的 alias，不冒充 ZeroClaw Instance；原生 session ID 由 VOKO 在会话绑定中保存。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人验证码或 alias/Provider 配置批准使用 Web/交互式注册。ACP-WebSocket 已配置 URL/token 时推荐 `ACP WebSocket → ACP → CLI → Pull`；没有 WS 配置时选择 `ACP → CLI → Pull`。

## 1. 安装和本地配置

在启动 VOKO 的同一个用户环境中确认：

```powershell
zeroclaw --version
zeroclaw status
zeroclaw agents list
Get-Command zeroclaw
```

本机实测 ZeroClaw `0.8.3`。ZeroClaw 没有必须先完成的 VOKO 登录步骤；模型 Provider、API Key 和 Agent 安全策略由 ZeroClaw 自己管理。常见配置位置为：

```text
%USERPROFILE%\.zeroclaw\config.toml
%USERPROFILE%\.zeroclaw\data
```

确认目标 alias 存在，并用最小权限运行：

```powershell
zeroclaw security status --agent voko_test --json
```

不要把 `config.toml`、API Key、pairing token 或安全状态完整输出到日志。

## 2. VOKO 注册

1. 启动 `voko start`，打开 `http://localhost:3100`，添加 Agent。
2. Provider 选择 **ZeroClaw**（协议值为 `zeroclaw`）。
3. 在 Instance/alias 字段填入已经存在且经过安全检查的 ZeroClaw Agent alias，例如 `voko_test`。这里只是选择运行配置，不是创建一个新的 ZeroClaw 进程实例。
4. 推荐通道：

   ```text
   ACP WebSocket → ACP → CLI → Pull
   ```

   如果预检明确提示 ACP-over-WebSocket 需要 URL/token 配置，不要猜测地址或 Token；先完成下面的 WS 配置，或者暂时选择本机 `ACP → CLI → Pull`。

5. 完成后检查：

   ```powershell
   voko doctor --deep
   voko status --json
   ```

当前 VOKO 的 CLI 是 ACP Provider 内部的降级路径，所以某些状态页可能显示 ACP 可用、CLI 为 `unknown`；只要 ACP 可用并已保留 Pull，不要据此手工改写配置。

## 3. VOKO 的投递方式

### ACP 主通道

VOKO 启动：

```text
zeroclaw acp
```

并在 `newSession` 时传入已注册的 Agent alias。后续使用 ZeroClaw 原生 `sessionId` 的 `loadSession` 恢复；不发送虚构的 `agentAlias` 作为 session ID。

### ACP-over-WebSocket（推荐实时通道）

ZeroClaw `0.8.x` 的网关 ACP WebSocket 使用本机回环地址和配对产生的 Bearer token：

```text
ws://127.0.0.1:42617/acp
Sec-WebSocket-Protocol: zeroclaw.acp.v1
Authorization: Bearer <pairing-derived-token>
```

先启动网关并完成一次配对，再把以下变量设置在启动 VOKO 的同一个用户环境中：

```powershell
zeroclaw gateway
$env:ZEROCLAW_ACP_URL = "ws://127.0.0.1:42617/acp"
$env:ZEROCLAW_ACP_TOKEN = "<pairing-derived-token>"
voko start
```

不要把 token 放进 URL 查询参数、`backend_instance_id`、项目文件或日志。URL 必须是无查询参数的本机回环地址；远程地址或未经 TLS 保护的公网地址不会被 VOKO 接受。

配置完成后，选择 `ACP WebSocket → ACP → CLI → Pull`。`voko status --json` 中该 Agent 的 `activeMode` 应为 `acp_ws`，对应方法的 Provider 应为 `zeroclaw-ws`。

### CLI 降级

主通道确认未投递时，VOKO 可使用：

```text
zeroclaw agent --agent <alias> --session-state-file <VOKO 管理的隔离文件> --log-level warn
```

state file 按 Agent、alias、私聊/群聊和会话键哈希生成，并以仅用户可读权限保存。不要自己复用另一个 Agent 的 state file，也不要把它放进项目仓库。

## 4. 会话恢复

绑定范围固定为：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

ZeroClaw alias 只决定使用哪个运行配置；同一 VOKO 会话的原生 session ID 才决定上下文。ACP、CLI 降级和恢复不会把不同访客、群聊或 Agent 的 session 混在一起。原生 session 失效时，VOKO 标记旧绑定为 stale，创建新的隔离会话，不猜测 ZeroClaw 最近会话。

## 5. 最小验收

```powershell
voko probe --agent-id <agent-id> --visitor-id zeroclaw-smoke-<date> --confirm `
  --message "Please reply with one short natural-language sentence confirming that Voko reached ZeroClaw." `
  --timeout 240
```

再次使用同一访客 ID 验证 `loadSession`：

```powershell
voko probe --agent-id <agent-id> --visitor-id zeroclaw-smoke-<date> --confirm `
  --message "Continue the same conversation and confirm that the ZeroClaw session was resumed." `
  --timeout 240
```

不要要求只返回全大写下划线标记；VOKO 会将其视作系统消息过滤。

本机 Windows 实测（ZeroClaw `0.8.3`，2026-08-06）：

- `zeroclaw status`、Agent alias 和安全配置预检通过；
- 完成 `zeroclaw` Agent 注册，保存 alias `voko_test`；
- ACP WebSocket 首条消息和同一访客续接均成功，ZeroClaw 保持同一个原生 session；
- CLI fallback 的 alias/state-file 隔离配置通过预检；
- `voko status --json` 显示 `acp_ws → acp → cli → pull`，对应 Provider 为 `zeroclaw-ws`。

## 6. 常见问题

- alias 不存在：先在 ZeroClaw 中创建/检查 Agent，再重新运行 VOKO 注册预检；不要在 VOKO 中拼写一个未存在的 alias。
- ACP 可用但 CLI 显示 `unknown`：这是内部 fallback 的状态展示差异，优先看 ACP 的健康状态和 Pull；不要把 alias 改成 session ID。
- WS 需要配置：使用 ZeroClaw 官方配置流程设置 URL/token，完成后重新预检；不要把 Token 放到 `backend_instance_id`。
- 会话串台：检查是否复用了 state file 或把多个访客写成同一个 channel ID；让 VOKO 重新创建 stale binding。
- 回复超时：ZeroClaw 首次模型调用可能较慢，等待明确结果后再决定；不要自动重发同一条消息。

ZeroClaw 的配置、凭据、pairing token、state file、原生 session ID 和访客原文都必须脱敏处理。
