# Cursor Agent CLI Provider 专属指南

Agent通过MCP收发消息时，先阅读[消息与精确Conversation接口契约](../mcp-message-conversations.md)：优先使用 `replyToMessageId`，按需使用VOKO `conversationId`，不要把Provider原生Session/thread ID当作VOKO会话ID。

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 VOKO 调用 Cursor Agent CLI 的安装、登录、注册、ACP/Plan CLI 投递和会话恢复。Cursor Agent 调用 VOKO MCP 时，属于另一条方向，仍按 [MCP 客户端配置](../mcp-client-setup.md) 配置。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人验证码或配置批准使用 Web/交互式注册。接收消息推荐 `ACP → CLI → Pull`；ACP 未就绪时先使用 Plan CLI，不要把 workspace 名称当作 Instance。

## 1. 安装、版本和登录

在启动 VOKO 的同一个 Windows 用户环境中确认官方运行入口：

```powershell
cursor-agent --version
cursor-agent status
Get-Command cursor-agent
```

本机实测 Cursor Agent `2026.07.23-e383d2b`，登录状态通过 `cursor-agent status` 确认。未登录时使用：

```powershell
cursor-agent login
```

VOKO 会解析 Cursor 官方安装目录中的真实 Node 入口，不要求用户手写 `.cmd`、`.ps1` 或 `node.exe` 路径。若你修改了 PATH、更新 Cursor 或更换登录用户，请重启 VOKO。

## 2. VOKO 注册

1. 启动 `voko start`，打开 `http://localhost:3100`，添加 Agent。
2. Provider 选择 **Cursor Agent CLI**（协议值为 `cursor`）。不要把 Cursor workspace 名称当作 `backend_instance_id`。
3. 推荐通道：

   ```text
   ACP → CLI → Pull
   ```

4. 完成后检查：

   ```powershell
   voko doctor --deep
   voko status --json
   ```

如果新注册的 Agent 还显示 Pull，重启一次 VOKO 让 Dispatcher 读取新的 Provider 路由。

## 3. VOKO 的安全运行方式

### ACP

主通道启动官方运行入口的 `acp` 子进程，并在临时工作目录建立隔离 ACP 会话。入口可用不等于进程健康；ACP 退出或握手失败时，下一条消息才会走可用的备通道，健康检查/显式恢复并重新握手后才恢复 ACP。

### Plan CLI

CLI 备通道等价于：

```text
cursor-agent -p --output-format stream-json --mode plan --trust --workspace . <prompt>
```

`plan` 是只读模式，`trust` 只跳过无头环境的 workspace trust 交互，不等于 `--yolo`。VOKO 不启用写文件、Shell 或 MCP 自动批准权限。不要为了测试手工加 `--force`、`--yolo` 或 `--approve-mcps`。

## 4. 会话恢复

绑定范围固定为：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

CLI 返回的 Cursor 原生 `session_id` 会保存到 VOKO 绑定，后续使用 `--resume <session_id>`。ACP 与 CLI 之间切换不应改变访客会话键；不同 Agent、访客、私聊和群聊不会共享会话。原生会话失效时，VOKO 创建隔离的新会话，不猜测 Cursor 的最近会话，也不对结果不明确的消息自动重发。

## 5. 最小验收

```powershell
voko probe --agent-id <agent-id> --visitor-id cursor-smoke-<date> --confirm `
  --message "Please reply with one short natural-language sentence confirming that Voko reached Cursor Agent." `
  --timeout 180
```

不要要求 Cursor 只返回全大写下划线字符串；VOKO 会把这种格式视作系统标记并过滤。若 ACP 首条消息较慢，等到明确成功/超时后再判断，不要并行重复投递。

本机 Windows 实测（Cursor Agent `2026.07.23-e383d2b`，2026-08-06）：

- `cursor-agent status` 确认真实登录账号；
- ACP Agent 首条消息和同一访客续接成功；
- CLI-only Agent 首条消息和同一访客续接成功；
- VOKO 使用官方安装目录解析结果，未把完整路径、凭据或原生 session ID 写入文档。

## 6. 常见问题

- `cursor-agent` 找不到：在启动 VOKO 的同一终端执行 `Get-Command cursor-agent`，修正 PATH 后重启。
- ACP/CLI 都显示不可用：执行 `cursor-agent status`，确认登录用户和网络；再运行 `voko doctor --deep`。
- 只有 Pull：确认注册时启用了 ACP 或 CLI，并重启 VOKO。
- 回复超时：先检查是否实际已启动 Cursor 子进程，再查看会话页面；结果不明确时不要立即发送第二遍。
- 需要测试写操作：不要通过 VOKO 访客消息放开权限；单独在 Cursor 交互终端测试，并与 VOKO 的只读 Provider 隔离。

Cursor 的登录存储、配置、原生 session ID 和访客原文不要提交到仓库或问题单。反馈只保留已脱敏的版本、通道、状态和耗时。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 Cursor Agent 2026.07.23-e383d2b。
- 官方用户安装目录被 Runtime Resolver 发现；登录、Voko 注册、ACP 首条消息和同一访客续接均通过。
- 推荐接收通道：`ACP → CLI → Pull`。普通问候消息通过；要求外部高风险操作时，Cursor 的访客安全策略可能拒绝。
- 若非交互 shell 找不到 `cursor-agent`，先确认官方安装目录和 `cursor-agent status`，再重启 Voko 刷新路径缓存。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
