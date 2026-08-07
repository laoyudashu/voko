# Hermes Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 **VOKO 调用 Hermes** 时的安装、profile 选择、HTTP/CLI 投递和排障。Hermes 作为 MCP 客户端调用 VOKO 时，属于另一条方向，需结合 Hermes 自身的 `mcp` 命令配置。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人验证码或 profile/Provider 配置批准使用 Web/交互式注册。接收消息优先选择 `HTTP → CLI → Pull`；HTTP Gateway/profile 尚未就绪时先选择 `CLI → Pull`。

## 1. 安装、模型和 profile

在启动 VOKO 的同一个用户环境中确认：

```bash
hermes --version
hermes status
hermes profile list
```

当前本机实测 Hermes Agent 0.19.0。先通过 Hermes 自身完成安装、模型和 Provider 配置：

```bash
hermes setup
hermes model
```

Windows 默认数据目录通常位于：

```text
%LOCALAPPDATA%\hermes\
```

其中的 `.env`、`config.yaml`、`profiles\<profile>\` 必须对启动 VOKO 的用户可读写。`hermes status` 可能显示 API Key 的部分掩码，排障时不要把完整输出直接贴到公开 issue 或聊天中。

## 2. 注册时选择 profile

Hermes 的 `backend_instance_id` 对应 Hermes profile，例如 `default`、`psychologist`、`zodiac`。profile 是模型/网关运行配置，不等于某个访客会话。

在 VOKO 注册页面中：

1. Provider 选择 **Hermes**。
2. Instance/profile 选择实际已配置模型和网关的 profile。
3. 通道选择：

   ```text
   HTTP → CLI → Pull
   ```

4. 完成后执行：

   ```bash
   voko doctor --deep
   voko status --json
   ```

确认 `deliveryStatus.activeMode` 为 `http`，并确认 `imConnection.connected/status`。注册成功、HTTP gateway 可用和 IM Worker 已连接是三个不同检查项。

不要把 VOKO Agent ID 当成 Hermes profile；也不要把 profile 名称当成访客 session。多个 VOKO Agent 如共享同一个 Hermes profile，消息仍会通过 VOKO 的 Agent/session key 隔离，但模型资源和 profile 级配置是共享的；除非确定需要共享，否则建议一 Agent 一 profile。

## 3. HTTP 主通道和 session

HTTP Provider 通过 Hermes 本机 API 发送消息，并使用稳定的 VOKO session key：

```text
hermes:<voko-agent-id>:<visitor-or-group-key>
```

同一 Agent、同一私聊/群聊会持续使用同一个 key；不同 Agent、不同访客、私聊和群聊不会串台。不要手动改写这个 key，也不要复制其他 Agent 的绑定记录。

Hermes HTTP 首次回复时间受模型和 Gateway 状态影响，几十秒是可能的。请求已进入 VOKO 后，不要因为短时间没有回复就重复发送同一条消息；先查看绑定和运行状态。

## 4. CLI 降级和 Pull

Hermes 的正常顺序为：

1. HTTP gateway 健康时走 `hermes-http`。
2. HTTP 不可用时，下一条消息可降级到 `hermes-cli`。
3. CLI 执行失败、等待工具授权或超时时，消息保留在 VOKO。
4. HTTP 健康检查恢复后，后续消息重新走 HTTP。

CLI 降级不是把 profile 变成新的实例，也不会重置 VOKO 的会话边界。若 CLI 报告 `pending approval`，需要在 Hermes 侧完成工具授权或关闭不适合访客托管的工具；不要通过 `--yolo` 或其他方式扩大访客权限。

网关排障时可在前台运行指定 profile：

```bash
hermes --profile <profile> gateway run --replace
```

另一个终端观察：

```bash
hermes --profile <profile> gateway status
hermes gateway list
```

Gateway 由 VOKO 按需管理时，不要同时启动多个相同 profile 的替代进程，否则端口和 session 状态可能互相干扰。

## 5. Hermes 作为 MCP 客户端

如果 Hermes 需要调用 VOKO 工具，使用 Hermes 的 MCP 管理命令，不要把 VOKO 的固定历史端口写入模型提示词：

```bash
hermes mcp list
hermes mcp add --help
hermes mcp test <server-name>
```

具体 `hermes mcp add` 参数随 Hermes 版本和配置方式变化，优先使用当前版本的帮助或交互式配置。无论使用哪种 MCP 客户端，推荐入口都是 `voko mcp` stdio；这和 VOKO → Hermes 的 HTTP/CLI 投递配置相互独立。

## 6. 常见问题

- profile 不存在：运行 `hermes profile list`，在 VOKO 注册时选择完全相同的 profile ID。
- HTTP 未就绪：运行 `hermes status` 和 `hermes gateway list`，检查模型凭证、端口和 profile 配置。
- 首条消息很慢：先等待当前请求完成，不要重复发送；查看 VOKO 的 `activeMode` 和 Hermes gateway 日志。
- 自动回复进入 Pull：检查 HTTP/CLI 是否在注册时启用；Pull-only 不会主动推送。
- CLI 等待授权：按 Hermes 的授权提示处理，访客消息不应自动获得 shell、网络或写文件权限。
- 回复被 VOKO 审计拦截：这是出站内容审核结果，不代表 Hermes HTTP 请求失败。
- Provider 正常但访客收不到：检查 `imConnection.connected/status`，再检查 VOKO 本地消息记录。

## 7. 本机验证边界

当前已在 Windows Hermes 0.19.0、已配置 profile 上验证：

- Hermes HTTP gateway 可用，VOKO `hermes-http` 能收到回复；
- 连续两条消息保持相同 `hermes:<agent>:<visitor>` session key；
- 回复写入 VOKO 消息记录；
- HTTP/CLI 降级和恢复已有兼容性回归覆盖。

其他 Hermes 版本、模型 Provider、profile 组合和工具授权策略仍需单独验证。不要提交 API Key、`.env` 内容、完整 profile 配置、私密会话或完整访客提示词。
