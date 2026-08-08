# Cline Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 **VOKO 调用本机 Cline** 时的安装、登录、注册、ACP 主通道、Plan CLI 降级和会话恢复。Cline 作为 MCP 客户端调用 VOKO 时，属于相反方向，按 [MCP 客户端配置](../mcp-client-setup.md) 配置即可。

## Agent 快速路径

- **Agent → VOKO 注册**：优先调用 MCP 工具 `voko_manage_agent_registration`；MCP 不可用时使用 `voko manage_agent_registration --action start --registration-mode agent`。
- **主人通过界面注册**：使用 VOKO Web UI 或有 TTY 的 `voko manage_agent_registration --interactive`，适合邮箱验证码、Provider 配置批准和人工选择。
- **VOKO → Cline 接收**：注册 Provider 类型 `cline`，推荐 `ACP → CLI → Pull`。ACP 是实时主通道，CLI 是受限 Plan 备通道，Pull 始终保留。
- 只选择注册预检标记为 `ready` 的方式；修改 Cline 登录、PATH 或配置后重启 VOKO，再检查 `activeMode` 和 `availableModes`。

## 1. 安装、版本和登录

使用 Cline 官方安装方式安装 CLI，并确保启动 VOKO 的同一用户可以找到它：

```powershell
cline --version
Get-Command cline
cline auth
```

首次使用或切换账户时，先完成 `cline auth`。不要把认证信息、配置文件内容或访问令牌复制到 VOKO Agent 描述、MCP 参数或日志中。

Windows 下 VOKO 会解析 Cline 的真实 Node 包入口，避免把 `.cmd`/`.ps1` 包装脚本直接当成 ACP 原生进程启动。`Get-Command cline` 能找到包装脚本，不代表 ACP 握手一定健康；仍需执行注册预检和真实消息测试。

## 2. VOKO 注册

1. 启动 VOKO：

   ```bash
   voko start
   ```

2. 打开当前 `voko status --json` 返回的本地端口，在注册流程中选择 Provider **Cline**，协议值为 `cline`。
3. 推荐选择：

   ```text
   ACP → CLI → Pull
   ```

4. 让注册流程完成 `inspect_environment` 和通道预检。只启用状态为 `ready` 的自动方式；如果 ACP 尚未可用，可以先选择 `CLI → Pull`，之后在 ACP 恢复后重新注册或更新通道。
5. 注册完成后检查：

   ```bash
   voko status --json
   voko doctor --deep
   ```

如果注册后已运行的 VOKO 仍显示 Pull-only，先确认 `cline auth` 和 PATH，再完全重启 VOKO，使 Provider 重新解析入口和路由缓存。

## 3. 投递边界

### ACP 主通道

VOKO 以 `cline --acp` 启动隔离 ACP 会话。Cline ACP 进程退出、握手失败或被健康检查标记不可用时，Dispatcher 会立即失效该 Agent 的 ACP 路由；下一条消息才会选择 CLI，不会在同一条消息上并行投递。

### Plan CLI 备通道

CLI 备通道使用 Cline Plan/JSONL 模式，并关闭自动批准：

```text
cline --plan --json --auto-approve false
```

VOKO 还会使用命令权限策略拒绝外部访客触发 Shell、文件修改或其他工具操作。不要为了提高成功率手工改成全权限交互式命令，也不要把访客消息直接转发到允许工具执行的 Cline 配置。

### Pull 兜底

ACP 和 CLI 都不可用时，消息保留在 VOKO。Cline 或其 MCP 客户端可以通过 `voko_fetch_new_messages` 主动读取；Pull 是可靠的接收方式，不代表消息已经丢失。

## 4. 会话、降级和恢复

- ACP 使用 VOKO 为 `(Agent、私聊/群聊、访客会话)` 保存的会话绑定；不同 Agent、访客、私聊和群聊不会共享会话。
- ACP → CLI → ACP 只切换投递通道，不改变会话边界，不应重复回复同一条消息。
- ACP 入口存在不等于 ACP 进程健康。`healthCheck()` 或显式恢复完成握手并发布可用事件后，下一条消息才会重新升级到 ACP。
- 原生会话无法恢复时，VOKO 会将绑定标记为 stale 并创建隔离的新会话；不会猜测 Cline 最近会话，也不会对结果不明确的投递自动重试。
- 发送后不要因为等待较久就并行再次发送；先查看状态或使用 Pull 确认。

## 5. 最小验收

建议按以下顺序验证：

1. `cline auth`、`voko doctor --deep` 均通过。
2. 注册 `cline` Agent，确认 `deliveryModes` 为 `acp, cli, pull`，并发送一条短消息。
3. 在同一访客会话发送第二条消息，确认会话能够续接。
4. 主动终止 Cline ACP，发送下一条消息，确认只走一次 CLI 并只产生一条回复。
5. 恢复 ACP 或运行健康检查，确认下一条消息重新使用 ACP。
6. 检查日志和状态输出不包含 Token、完整访客提示词、原生 session ID 或私密配置路径。

当前已完成 Windows 实机 ACP 首条消息、会话续接、ACP 终止后的 CLI 单次降级、健康恢复后的 ACP 重连及敏感日志检查。其他操作系统、不同 Cline 版本和高并发场景仍应按实际环境重新验收。

## 6. 常见问题

- **注册后只有 Pull**：确认 `cline --version`、`cline auth` 和 `voko doctor --deep`，检查注册时是否选择了 ready 的 ACP/CLI，然后重启 VOKO。
- **ACP 连接后立即退出**：先单独运行 Cline 的 ACP/认证检查，确认模型凭据和用户配置，再让 VOKO 重试；不要通过放开工具权限绕过问题。
- **CLI 有回复但 ACP 没有升级**：检查 `activeMode`、ACP 进程健康和恢复事件；路由缓存会在事件到达时刷新，必要时完全重启 VOKO。
- **Cline 能调用 VOKO MCP，但 VOKO 推不进 Cline**：这是两个方向，分别检查 Cline 的 MCP 配置和 VOKO Agent 的 ACP/CLI 预检。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 Cline 3.0.51。
- `cline` 登录态、Voko 注册、ACP 首条消息和同一访客续接均通过。
- 推荐接收通道：`ACP → CLI → Pull`。ACP 进程异常时下一条消息只降级一次 CLI；健康恢复后再升级 ACP。
- 访客消息仍受 Cline 安全边界约束；测试中要求精确外部 Token 的提示会被拒绝，普通自然语言消息正常。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
