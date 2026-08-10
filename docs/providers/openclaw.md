# OpenClaw Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 **VOKO 调用 OpenClaw** 时的安装、实例选择、WebSocket/CLI 投递和排障。OpenClaw 作为 MCP 客户端调用 VOKO 时，请看本文的 MCP 小节；这和 VOKO 向 OpenClaw 推送访客消息是两个方向。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；需要主人输入验证码或批准 Gateway 配置时使用 Web/交互式注册。接收消息优先选择 `WebSocket → CLI → Pull`；Gateway 尚未稳定时先选择 `CLI → Pull`。

## 1. 安装和 Gateway 检查

在启动 VOKO 的同一个用户环境中确认：

```bash
openclaw --version
openclaw config file
openclaw doctor --lint
```

Windows 下 VOKO 会解析 `openclaw` 的真实 Node 入口，避免把 `.cmd`/`.ps1` 包装脚本当成 WebSocket 进程直接启动。OpenClaw 当前配置文件通常是：

```text
~/.openclaw/openclaw.json
```

其中 Gateway 的端口、认证和 Agent 列表必须保持有效。不要把 Token、完整配置或 Secret 输出到问题报告中。

可用以下命令确认 Gateway 相关配置，端口以实际输出为准：

```bash
openclaw config get gateway.port
openclaw config get gateway.mode
```

也可以在本机检查：

```text
http://127.0.0.1:<gateway.port>/health
```

Gateway 未运行时，VOKO 的 WebSocket Provider 可能会尝试启动它；为了注册过程更顺畅，建议先让 `openclaw doctor --lint` 通过并确认 Gateway health 正常。

## 2. 注册时选择正确的实例

OpenClaw 的实例对应 `openclaw.json` 中 `agents.list[].id`，例如 `main`、`gym`、`lawyer`。它是工作区/Agent 选择，不是访客会话 ID。

在 VOKO 注册页面中：

1. Provider 选择 **OpenClaw**。
2. Instance 选择实际要接收消息的 OpenClaw Agent ID，不要为了省事选择 `main`。
3. 通道选择：

   ```text
   WebSocket → CLI → Pull
   ```

4. 完成注册后执行：

   ```bash
   voko doctor --deep
   voko status --json
   ```

如果 WebSocket 显示 `configuration_required`，先完成 VOKO 注册流程要求的主人确认和 Gateway 配置，不要直接编辑 `voko.db`。

## 3. 消息路由和会话边界

### Caller identity for `whoami`

OpenClaw's Gateway `sessionKey` is a routing selector and is not automatically exposed as an external MCP caller identity. VOKO therefore accepts OpenClaw instance context only from a VOKO-managed adapter or an explicitly trusted integration; it does not infer identity from the workspace, the newest transcript, or a Gateway session list. The rule is the same on Linux, Windows, and macOS: if multiple OpenClaw Agents cannot be uniquely identified, choose one with `voko_list_agents` and retry `whoami` with `agentId`.

OpenClaw 的 VOKO 绑定按以下组合隔离：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

实际发送时会使用类似下面的 OpenClaw session key：

```text
agent:<openclaw-agent-id>:<visitor-id>
```

因此要区分：

- `backend_instance_id`：OpenClaw 配置中的 Agent ID，用来选择 workspace。
- `native_session_id`：某个 VOKO 会话使用的 OpenClaw session key。
- `channelType/channelId`：VOKO 的私聊/群聊边界。

不同 VOKO Agent、不同访客、私聊和群聊不会共享 session。不要把一个实例 ID 当成 session ID，也不要手动把访客的 session key 复制给另一个 Agent。

## 4. WebSocket、CLI 降级和 Pull

正常情况下 VOKO 优先使用 OpenClaw WebSocket：

1. WebSocket 健康时，访客消息实时推送到对应 session。
2. Gateway 断开、认证失败或 WebSocket 被健康检查标记不可用时，下一条消息降级到 OpenClaw CLI。
3. WebSocket 恢复并重新完成握手后，后续消息再次升级到 WebSocket。
4. 两个自动通道都不可用时，消息保留在 VOKO，Agent 通过 Pull 读取。

降级只切换投递通道，不改变 VOKO 会话边界；不会因为 WebSocket → CLI → WebSocket 自动重复回复。查看当前状态：

```bash
voko status --json
```

关注 Agent 的 `activeMode`、`availableModes` 和 `deliveryStatus`。如果显示 `websocket`，不要因为初始化期间短暂延迟而手动改成 CLI；Dispatcher 会根据健康事件刷新路由缓存。

## 5. OpenClaw 作为 MCP 客户端

如果 OpenClaw 需要调用 VOKO 工具，建议使用 stdio MCP，而不是固定本地 HTTP 端口。当前版本的配置命令可先查看：

```bash
openclaw mcp list
openclaw mcp status
openclaw mcp doctor
```

新增 VOKO stdio 服务器时可使用：

```bash
openclaw mcp add voko --command voko --arg mcp
```

该命令会探测并写入 OpenClaw 配置；如果已有名为 `voko` 的服务器，请先查看现有配置再更新，不要覆盖其他 MCP 服务器。修改后执行：

```bash
openclaw mcp reload
openclaw mcp probe voko
```

这段配置只表示 **OpenClaw → VOKO MCP**，不会自动把 OpenClaw 注册成 VOKO Provider；Provider 注册仍需在 VOKO Web UI 或注册状态机中完成。

## 6. 常见问题

- `openclaw` 找不到：在启动 VOKO 的同一终端执行 `openclaw --version`，修改 PATH 后重启 VOKO。
- Gateway health 不通：执行 `openclaw doctor --lint`，确认端口、认证和配置文件权限；不要把 Gateway Token 填入 VOKO Agent 的普通描述字段。
- 消息进入 CLI：先看 `voko status --json` 的 WebSocket 可用状态，再检查 Gateway 日志；CLI 是设计好的降级路径，不代表消息丢失。
- 回复没有返回访客：检查 IM Worker 的 `imConnection.connected/status`。Provider 连接和 IM 连接是两个独立状态。
- 中文乱码：统一 Windows 终端为 UTF-8 后再判断是否为 OpenClaw 路由问题。
- 访客提示词触发 VOKO 审计：审计拦截不等于 WebSocket 或 CLI 失败。

## 7. 本机验证边界

当前已在 Windows OpenClaw 2026.6.1 上验证：

- Gateway health 可用，VOKO WebSocket 路由可建立；
- 连续两条访客消息使用同一个 OpenClaw session key；
- 回复能够回写 VOKO 消息记录；
- CLI 降级、恢复和实例隔离已有兼容性回归覆盖。

其他 OpenClaw 版本、认证方式、第三方频道和自定义插件仍需单独验收。报告问题时只提供版本、实例 ID 的脱敏形式、通道和最小复现步骤，不要提交 Token、完整配置、workspace 路径或访客原文。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 OpenClaw 2026.6.1。
- Gateway 自动启动并完成 WebSocket 认证；Voko 注册、CLI 首条消息和同一访客续接均通过。
- 本轮 Agent 注册为 `CLI → Pull`，所以 Dispatcher 实际使用 OpenClaw CLI；Gateway WS 在线不等于该 Agent 已选择 WS。
- 若要使用 WS，注册时显式保留对应 WebSocket 模式，并以 `voko doctor --deep` 的 active mode 检查；WS 异常时路由缓存会降级 CLI。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
