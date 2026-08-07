# GitHub Copilot CLI Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 VOKO 调用 GitHub Copilot CLI 的登录、注册、ACP 投递、会话续接和安全边界。Copilot 调用 VOKO MCP 属于相反方向，仍按 [MCP 客户端配置](../mcp-client-setup.md) 配置。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人 OAuth、验证码或配置批准使用 Web/交互式注册。接收消息推荐 `ACP → CLI → Pull`；优先 ACP，不要为了 CLI 备通道手工放开 Copilot 工具或远程能力。

## 1. 安装和登录

在启动 VOKO 的同一个用户环境中确认：

```powershell
copilot --version
copilot login --help
Get-Command copilot
```

本机实测 GitHub Copilot CLI `1.0.76`。首次登录使用浏览器 OAuth/设备流程：

```powershell
copilot login
```

无图形环境可使用受支持的环境变量认证（例如 `COPILOT_GITHUB_TOKEN`、`GH_TOKEN` 或 `GITHUB_TOKEN`），但不要把 Token 写入 VOKO Agent 配置、注册描述、命令行历史或日志。企业 GitHub Cloud 数据驻留环境按 Copilot CLI 的 `--host` 选项登录。

## 2. VOKO 注册

1. 启动 `voko start`，打开 `http://localhost:3100`，添加 Agent。
2. Provider 选择 **GitHub Copilot CLI**（协议值为 `github-copilot`）。
3. 推荐通道：

   ```text
   ACP → CLI → Pull
   ```

4. 完成后检查：

   ```powershell
   voko doctor --deep
   voko status --json
   ```

当前 VOKO 的 Copilot CLI 备通道由 ACP Provider 内部管理；因此某些版本的 `status --json` 可能显示 ACP 可用、CLI 状态为 `unknown`。这不影响 ACP 主通道，但若需要强制 CLI-only，应先确认当前 VOKO 版本提供了独立 CLI Provider。

## 3. VOKO 的安全参数

VOKO 的 ACP 进程等价于启动：

```text
copilot --acp --no-custom-instructions --disable-builtin-mcps --no-remote --no-remote-export --available-tools= --no-ask-user --no-auto-update
```

这组参数的目的，是让外部访客消息只能得到文字回复，不加载项目指令、不启用内置/远程 MCP、不导出会话、不让 Agent 等待用户确认工具。不要在 Provider 配置里改成 `--allow-all`、`--yolo` 或 `--allow-all-tools`。

当 ACP 明确确认未投递时，VOKO 可以尝试受限 Copilot CLI；ACP 进程健康状态变化会刷新 Dispatcher 路由。结果不明确时不会跨通道重发同一条消息，最终保留 Pull。

## 4. 会话恢复

绑定范围固定为：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

Copilot ACP `newSession` 返回的原生 session ID 会保存到本地绑定，同一访客的下一条消息使用相同会话恢复。不同 Agent、访客、私聊和群聊不会共享。不要从 Copilot 的最近会话列表猜测 ID，也不要把 session ID 放入文档或日志。

## 5. 最小验收

```powershell
voko probe --agent-id <agent-id> --visitor-id copilot-smoke-<date> --confirm `
  --message "Please reply with one short natural-language sentence confirming that Voko reached GitHub Copilot." `
  --timeout 180
```

第二次使用同一个 `visitor-id`，验证续接：

```powershell
voko probe --agent-id <agent-id> --visitor-id copilot-smoke-<date> --confirm `
  --message "Continue the same conversation and confirm that the session was resumed." `
  --timeout 180
```

不要要求只返回 `COPILOT_OK` 这类全大写下划线标记；VOKO 会将它识别为系统消息而过滤。

本机 Windows 实测（Copilot CLI `1.0.76`，2026-08-06）：

- 完成 Copilot Agent 真实注册，ACP/CLI/Pull 配置写入本地数据库；
- ACP 首条消息成功持久化并投递；
- 同一访客第二条消息成功续接原生 session；
- 日志未记录 Token、完整访客提示词或原生 session ID。

## 6. 常见问题

- `copilot` 找不到：在启动 VOKO 的同一终端确认 `Get-Command copilot`，修正 PATH 后重启 VOKO。
- 登录弹不出浏览器：先在有图形终端执行 `copilot login`，无图形环境改用官方支持的 Token 环境变量，并限制其作用域。
- ACP 可用但 CLI 显示 `unknown`：优先使用 ACP；这是当前 Provider 的运行时能力展示，不要擅自把 ACP 参数替换成全权限 CLI。
- 回复被安全规则拦截：Copilot 可能拒绝把外部访客消息当作主人指令；这是预期安全边界。不要通过放开工具权限绕过它。
- 新 Agent 只有 Pull：确认登录和预检后重启 VOKO，刷新 Dispatcher 路由缓存。

Copilot 凭据、配置文件、Token、原生 session ID 和访客原文都是敏感数据；问题反馈只提交脱敏后的版本、通道、状态和耗时。
