# Grok CLI Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 VOKO 调用 xAI Grok CLI 的安装、认证、注册、无工具 Plan 投递和原生 session 恢复。Grok 调用 VOKO MCP 时，按 [MCP 客户端配置](../mcp-client-setup.md) 单独配置。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人 OAuth、验证码或配置批准使用 Web/交互式注册。Grok 当前接收消息选择 `CLI → Pull`；认证、代理或模型未就绪时先保留 Pull。

## 1. 安装、版本和认证

在启动 VOKO 的同一个用户环境中确认：

```powershell
grok --version
grok doctor
grok inspect
Get-Command grok
```

本机实测 Grok CLI `0.2.118`，`grok doctor` 无阻断问题，项目信任状态正常。Grok 的认证由其自身欢迎/OAuth/API 配置流程管理；需要 OAuth 时使用：

```powershell
grok --oauth
```

如果版本显示的是交互欢迎页，按 Grok 提示完成登录后再运行 `grok inspect`。不要把 `%USERPROFILE%\.grok\config.toml`、API Key 或 OAuth 状态复制到 VOKO 配置和日志。

## 2. VOKO 注册

1. 启动 `voko start`，打开 `http://localhost:3100`，添加 Agent。
2. Provider 选择 **Grok CLI**（协议值为 `grok`）。Grok 不需要手工填写 OpenClaw Agent ID、Hermes profile 或虚构的 Provider Instance。
3. 推荐通道：

   ```text
   CLI → Pull
   ```

4. 完成后检查：

   ```powershell
   voko doctor --deep
   voko status --json
   ```

如果 VOKO 正在运行时刚完成注册但只显示 Pull，重启一次 VOKO 刷新 Dispatcher 路由缓存。

## 3. VOKO 的安全运行方式

每条外部访客消息使用一次非交互、单轮、只读 Grok 进程，等价于：

```text
grok --output-format streaming-json --permission-mode plan --tools=none \
  --disable-web-search --no-subagents --no-memory --max-turns 1 --verbatim \
  --session-id <new-id> --single <prompt>
```

后续同一会话使用 `--resume <native-session-id>`。VOKO 不启用工具、Web 搜索、子 Agent 或跨会话 memory；不要为了让访客执行操作而手工加 `--always-approve`、`--allow` 或 `--experimental-memory`。

Windows 下 VOKO 优先继承 `HTTP_PROXY`/`HTTPS_PROXY`；未设置时会尝试读取 WinHTTP loopback 代理。代理改变后重启 VOKO 并重新预检。

## 4. 会话恢复

绑定范围固定为：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

首次调用由 VOKO 生成并保存 Grok 原生 session ID，后续按同一绑定使用 `--resume`。不同 Agent、访客、私聊和群聊不会共享。原生 session 无法恢复时，VOKO 创建新的隔离 session，不猜测 Grok 的最近会话，也不会对结果不明确的消息重复投递。

## 5. 最小验收

```powershell
voko probe --agent-id <agent-id> --visitor-id grok-smoke-<date> --confirm `
  --message "Please reply with one short natural-language sentence confirming that Voko reached Grok." `
  --timeout 240
```

第二条消息使用同一访客 ID：

```powershell
voko probe --agent-id <agent-id> --visitor-id grok-smoke-<date> --confirm `
  --message "Continue the same conversation and confirm that the Grok session was resumed." `
  --timeout 240
```

不要要求只返回全大写下划线标记；VOKO 会将这种格式识别为系统消息并过滤。

本机 Windows 实测（Grok CLI `0.2.118`，2026-08-06）：

- `grok doctor`、`grok inspect` 和本机配置检查通过；
- 完成 Grok Agent 真实注册并启用 CLI → Pull；
- 首条消息成功，第二条消息使用同一 Grok 原生 session 成功续接；
- 本机代理解析和无工具 Plan 参数生效。

## 6. 常见问题

- `grok` 找不到：在启动 VOKO 的同一终端执行 `Get-Command grok`，修正 PATH 后重启。
- 认证失败或首条超时：先在同一用户终端完成 `grok --oauth`/欢迎页认证，再检查 `grok doctor`、`grok inspect` 和代理；不要立即重发。
- 只有 Pull：确认注册时启用了 CLI，重启 VOKO 后再看 `voko status --json`。
- 续接失败：不要手工粘贴 Grok 的最近会话 ID；让 VOKO 标记旧绑定失效并创建新会话。
- 回复被过滤：避免要求仅输出 `GROK_OK` 这类大写下划线标记，改用正常句子。

Grok 配置、凭据、原生 session ID、代理认证信息和访客原文均不得写入公共日志或文档。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 Grok CLI 0.2.118。
- 登录/模型配置、Voko 注册、无工具 Plan CLI 首条消息和同一访客续接均通过。
- 推荐接收通道：`CLI → Pull`；让 Voko 自动维护会话绑定，不要手工复制原生 session ID。
- 认证失败或 PATH 改动后先运行 Provider 自身 doctor/inspect，再重启 Voko；结果不明确时不要立即重发。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
