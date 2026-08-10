# Gemini CLI Provider 专属指南

Agent通过MCP收发消息时，先阅读[消息与精确Conversation接口契约](../mcp-message-conversations.md)：优先使用 `replyToMessageId`，按需使用VOKO `conversationId`，不要把Provider原生Session/thread ID当作VOKO会话ID。

本文只记录 Gemini CLI 作为 VOKO Provider 时的安装、认证、注册和接收消息方式。Agent 调用 VOKO MCP 的通用流程仍以[统一注册与投递路由规则](../provider-delivery-routing.md)为准。

## 1. 安装、登录和 Linux headless 注意事项

Ubuntu 实机验收版本：Gemini CLI 0.53.1；测试环境为 Ubuntu 24.04.4 LTS、VOKO Lite 0.4.3。先在同一用户下完成 Gemini CLI 的登录和模型配置，再启动 VOKO：

```bash
gemini --version
gemini
```

VOKO 以 Docker sandbox 运行 Gemini CLI。无图形或首次工作目录信任提示可能阻塞 headless 调用；当前 VOKO 已自动传入 `--skip-trust`，并使用 `--output-format stream-json --approval-mode yolo`，无需把访客消息提升为工具权限。

## 2. VOKO 注册与推荐通道

注册前确认预检能找到 `gemini`、Docker daemon 正常且 Gemini 登录态可用，然后选择：

```text
providerType: gemini
deliveryModes: cli, pull
```

推荐接收顺序为 `CLI → Pull`。Gemini CLI 当前没有可供 VOKO 持久化的原生 session binding，连续消息由 VOKO 的 context-window 历史续接；因此不要手工填写或伪造 session/instance 字段。

## 3. 最小验收

```bash
voko doctor --deep
voko status --json
```

用自然语言发送首条消息，再在同一访客会话发送第二条消息，确认两条都写入 VOKO 消息记录并返回。不要使用全大写下划线测试标记，这类内容会被 VOKO 的系统消息保护规则拦截。

## 4. 超时、503 和安全边界

- Docker 首次拉起或上游模型繁忙时可能需要较长时间；出现 503、pending 或超时，先查看消息记录和 `voko status --json`，结果不明确时不要重发同一条消息。
- VOKO 不会把 API key、完整访客提示词、Docker 配置路径或 Gemini 原生输出写入业务日志。
- Gemini 的工具审批仍受 VOKO 安全提示和 Provider 自身策略约束；不要通过访客消息要求修改安全配置或泄露凭据。

## 5. Ubuntu 实机结果（2026-08-07）

Gemini 0.53.1 已完成真实注册、首条回复和同一访客续接；一次上游高负载/长等待在重试后通过。后续若切换账号、模型、Docker 或 shell 环境，应重新运行预检和两条连续消息验收。

[完整 Ubuntu Linux 验收矩阵](linux-real-test-2026-08.md)
