# OpenCode Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 VOKO 调用本机 OpenCode 的安装、凭据、注册、ACP/CLI 投递和会话恢复。OpenCode 调用 VOKO MCP 属于相反方向，仍按 [MCP 客户端配置](../mcp-client-setup.md) 配置。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人验证码或模型/Provider 配置批准使用 Web/交互式注册。ACP 就绪时推荐 `ACP → Attach → CLI → Pull`；只有 Attach 服务就绪时才保留 Attach，ACP/Attach 未就绪可先用 `CLI → Pull`。

## 1. 安装、版本和凭据

在启动 VOKO 的同一个 Windows 用户环境中确认入口：

```powershell
opencode --version
Get-Command opencode
opencode auth list
```

本机实测 OpenCode `1.18.9`。OpenCode 的模型凭据由 OpenCode 自己管理；需要登录某个模型 Provider 时使用：

```powershell
opencode auth login
```

不要把 `auth.json` 的内容、API Key 或模型配置复制到 Agent 描述、注册结果或日志。更新 OpenCode、修改 PATH 或切换 Windows 用户后，重启 VOKO 再做预检。

## 2. VOKO 注册

1. 启动 `voko start`，打开 `http://localhost:3100`，添加 Agent。
2. Provider 选择 **OpenCode**。`backend_instance_id` 不需要填写 OpenCode 项目名；OpenCode 会话由 VOKO 按 Agent 和访客会话绑定。
3. 推荐通道：

   ```text
   ACP → Attach → CLI → Pull
   ```

   `Attach` 只有在你明确运行了 OpenCode server 并希望复用它时才有意义；只想稳定使用本机非交互调用时可选择：

   ```text
   CLI → Pull
   ```

4. 完成注册后执行：

   ```powershell
   voko doctor --deep
   voko status --json
   ```

如果新 Agent 在已经运行的 VOKO 中暂时只显示 Pull，完整重启一次 VOKO，让 Dispatcher 重新加载注册后的路由缓存。

## 3. VOKO 的运行边界

### ACP 主通道

VOKO 启动等价于：

```text
opencode acp
```

进程在临时工作目录启动，并使用隔离配置，拒绝访客消息直接修改项目、执行命令或连接外部 MCP。ACP 的进程健康和可执行入口是两件事：入口存在不代表当前 ACP 会话仍健康。连接恢复成功后才重新发布 ACP 可用状态。

### CLI 备通道

VOKO 使用非交互 JSON 输出：

```text
opencode run --format json <prompt>
```

CLI 只在注册时启用且主通道确认未投递时使用；结果不明确时不自动重复发送，消息保留到 Pull。不要自行替换成带写权限或外部插件的交互式命令。

## 4. 会话和恢复

绑定范围固定为：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

同一会话持续复用 VOKO 保存的 OpenCode 原生会话；不同 Agent、不同访客、私聊和群聊不会共享。不要从 OpenCode 最近会话列表猜测并填入 VOKO。原生会话无法恢复时，VOKO 创建新的隔离会话并尽量注入必要的本地历史，不会因为恢复不确定而重复投递。

## 5. 最小验收

使用新的访客 ID 做一次真实验证，提示词应要求自然语言确认，不要要求只返回全大写下划线标记（这类内容会被 VOKO 当作系统消息过滤）：

```powershell
voko probe --agent-id <agent-id> --visitor-id opencode-smoke-<date> --confirm `
  --message "Please reply with one short natural-language sentence confirming that Voko reached OpenCode." `
  --timeout 180
```

本机 Windows 实测（OpenCode `1.18.9`，2026-08-06）：

- 完成 OpenCode Agent 的真实注册，ACP/Attach/CLI/Pull 预检通过；
- ACP 首条消息和同一访客的第二条续接均持久化为 `sent`；
- 另建 CLI-only Agent，CLI 首条消息和会话续接均成功；
- 未把 OpenCode 的私密凭据、原生会话 ID 或完整提示词写入文档。

## 6. 常见问题

- `opencode` 找不到：在启动 VOKO 的同一终端执行 `Get-Command opencode`，修正 PATH 后重启 VOKO。
- ACP 首次等待较久：检查 `opencode auth list`、模型网络和 `voko doctor --deep`；先使用 `CLI → Pull` 完成稳定接入，再排查 ACP。
- 只有 Pull：确认注册时启用了 CLI/ACP，并重启 VOKO 使路由缓存刷新。
- 回复像“丢失”：先检查是否要求了类似 `OPENCODE_OK` 的全大写下划线输出；改为自然语言重新测试，并查看会话记录，避免盲目重发。
- 想启用 Attach：先由 OpenCode 自己启动受保护的 server，再在 VOKO 预检中确认端口和凭据，不要把服务地址或认证信息写入公共文档。

OpenCode 的配置、缓存、`auth.json`、原生 session ID 和访客原文都属于本地敏感数据；问题反馈只提交脱敏后的 Provider、通道、耗时和错误类型。
