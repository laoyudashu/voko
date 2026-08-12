# OpenHands Provider 专属指南

Agent通过MCP收发消息时，先阅读[消息与精确Conversation接口契约](../mcp-message-conversations.md)：优先使用 `replyToMessageId`，按需使用VOKO `conversationId`，不要把Provider原生Session/thread ID当作VOKO会话ID。

[Transport 行为矩阵](../provider-transport-matrix.md) · [统一注册与投递路由规则](../provider-delivery-routing.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 **VOKO 调用本机 OpenHands** 时的安装、模型配置、适配器验证和安全边界。当前 Catalog 尚未注册 OpenHands Push transport，因此生产运行按 `Pull-only` 处理；本文的 ACP/CLI 段落是适配器验证记录，不代表当前版本会自动 Push。OpenHands 作为 MCP 客户端调用 VOKO 时，属于相反方向，请按 [MCP 客户端配置](../mcp-client-setup.md) 配置。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；MCP 不可用时使用 `voko manage_agent_registration --action start --registration-mode agent`。当前 VOKO Provider 类型 `openhands` 选择 `Pull`；ACP/CLI 仅在后续 Catalog 迁移完成并通过真机门禁后才能启用。

## 1. 已验证版本和边界

本指南基于 Windows 真机验收，版本应明确区分 CLI 和 SDK：

| 组件 | 实测版本 |
| --- | --- |
| OpenHands CLI | **1.16.0** |
| OpenHands SDK（CLI 启动时显示） | **1.21.0** |
| VOKO Lite | 0.4.3 开发构建 |
| Node.js | 24.14.0 |
| 平台 | Windows（`win32`） |

版本号来自 `openhands --version` 的实际输出；升级 OpenHands、SDK、模型或操作系统后，应重新执行最小验收。本文不是对其他版本的兼容性承诺。

## 2. 安装、模型和登录

在启动 VOKO 的同一个用户和终端环境中确认 OpenHands 入口：

```powershell
openhands --version
Get-Command openhands
voko --version
```

Linux/macOS 使用 `which openhands` 替代 `Get-Command`。OpenHands 可按其官方安装方式部署；本次 Windows 实测入口来自用户的 `uv` 工具环境。修改安装、PATH 或用户配置后，完全退出并重启 VOKO。

OpenHands 必须先完成自身的模型/认证配置。VOKO 启动子进程时使用 `--override-with-envs`，支持从当前用户环境读取：

- `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`；
- 已配置 DeepSeek 时，也可使用 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`，VOKO 会映射给 OpenHands。

不要把 Token 写入 CLI 参数、Agent 描述、MCP 配置或问题日志。不要为了测试把 `OPENHANDS_PERSISTENCE_DIR` 指向一个空目录；ACP 需要当前用户已有的 OpenHands Agent 配置和认证状态，否则可能返回 `Authentication required`。

## 3. VOKO 注册

使用 Web/交互式流程或 Agent 自主注册流程选择：

| 注册字段 | 推荐值 | 说明 |
| --- | --- | --- |
| Provider 类型 | `openhands` | 当前 Catalog 为 Pull-only；ACP/CLI 适配器仍保留验证记录。 |
| 投递顺序 | `pull` | 当前版本不注册自动 Push transport。 |

注册后检查：

```powershell
voko doctor --deep
voko status --json
```

运行入口可用不等于 ACP 进程健康；注册预检、运行状态和实际首条消息都应分别确认。`backend_instance_id` 不是 OpenHands 原生 Instance，也不参与本次会话路由；不要手工伪造它来隔离会话。

## 4. 适配器验证（非当前自动 Push）

### ACP 主通道

VOKO 使用 OpenHands 标准 ACP stdio 入口：

```text
openhands acp --override-with-envs
```

ACP 会话按以下 VOKO 会话键隔离：

```text
(Agent、channelType、channelId)
```

每个键保存 OpenHands 返回的原生 session ID。不同 Agent、不同访客、私聊和群聊不会共享会话。

### CLI 备通道

ACP 不可用时，VOKO 使用 OpenHands headless JSON CLI，并通过短生命周期的受限 prompt 文件传递消息：

```text
openhands --headless --json --override-with-envs --file <temporary-prompt> --resume <native-session-id>
```

CLI 不使用“最近会话”或模糊名称续接。首次 CLI 会话会保存 OpenHands 输出的原生 ID；后续消息只使用该 ID 和 `--resume`。OpenHands ACP 返回带连字符的 UUID，而 CLI 摘要可能显示去掉连字符的 32 位形式，VOKO 会将两种表示规范化为同一个 session。

### Pull

Pull 的保留和消费规则以 [Transport 行为矩阵](../provider-transport-matrix.md) 为准；当前版本只需确认 `voko_fetch_new_messages` 或 VOKO CLI 能读取待处理消息。

## 5. 安全边界和 Provider 差异

通用通道顺序、降级次数、结果分类、Session binding 和 Pull 规则以 [Transport 行为矩阵](../provider-transport-matrix.md) 为准。OpenHands 的差异是：ACP 使用标准 ACP stdio，CLI 使用受限 headless JSON；两条路径都禁用终端、文件编辑、浏览器、MCP、网络、子代理和其他工具执行，不能为提高成功率改用全权限参数。

## 6. 最小验收流程

如果要继续推进 OpenHands Push 迁移，适配器验证可按以下顺序执行；这些步骤不会改变当前 Catalog 的 Pull-only 结论：

1. `openhands --version` 显示 CLI 1.16.0，并记录同时显示的 SDK 版本。
2. `voko doctor --deep` 显示 OpenHands 运行入口可用。
3. 在临时测试数据库中验证 `openhands` ACP/CLI，不要把未迁移的 Push 模式写入生产 Agent。
4. 发送第一条 ACP 消息，再在同一访客会话发送第二条，确认上下文连续。
5. 主动终止 ACP，发送下一条消息，确认只产生一条 CLI 回复。
6. 恢复 ACP 或运行健康检查，确认下一条消息回到 ACP，且原生 session ID 不变。
7. 请求 CLI 执行创建文件或终端命令，确认只返回文字拒绝，测试目录没有产生文件。
8. 检查日志不包含 Token、完整访客提示词、原生 session ID 或私密配置路径。

本机已完成 Windows OpenHands CLI 1.16.0 / SDK 1.21.0 的 CLI 首次与续接、ACP → CLI → ACP 适配器往返和 CLI 工具禁用验收；这属于适配器证据，不代表当前 Catalog 已启用自动 Push。

## 7. 排障

- **`Authentication required`**：先用同一用户完成 OpenHands 自身的认证和 Agent 配置；不要把持久化目录改成空目录，然后重启 VOKO。
- **当前只有 Pull**：这是当前 Catalog 的预期行为；只有 OpenHands transport 完成 Catalog 注册、灰度和真机门禁后才需要排查自动 Push。
- **ACP 启动较慢或出现 Git refresh 错误**：OpenHands 会刷新 public skills；VOKO 已让非交互 Git 快速失败并继续使用缓存。确认最终出现“ACP 连接就绪/会话就绪”，不要把单条 Git 刷新错误当作消息投递失败。
- **CLI 没有回复或没有 session ID**：不要并行重发；先查看 `voko status --json` 并通过 Pull 确认。VOKO 会把没有原生 session ID 的结果视为不确定结果，不自动重试。
- **ACP 没有重新升级**：检查健康状态和恢复事件；只有握手成功后下一条消息才会重新选择 ACP。

提交问题时只提供脱敏后的 VOKO 版本、OpenHands CLI/SDK 版本、操作系统、通道和最小复现步骤；不要提供 Token、原生 session ID、私密配置路径或完整访客提示词。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 OpenHands CLI 1.14.0 / SDK 1.16.1。
- headless 登录/模型配置、适配器级 ACP 首条消息和同一访客续接均通过。
- 当前生产注册仍选择 `Pull`；ACP/CLI 的历史验证结果只作为后续 Catalog 迁移的证据，不代表自动 Push 已启用。
- CLI/ACP 均在无图形终端验证；不要将持久化目录、Token、原生 session ID 或访客原文贴入日志。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
