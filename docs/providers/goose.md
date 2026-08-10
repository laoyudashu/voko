# Goose Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 **VOKO 调用 Goose** 时的安装、注册、会话路由、ACP/CLI 降级和排障。Goose 作为 MCP 客户端调用 VOKO 时，请先看 [MCP 客户端配置](../mcp-client-setup.md) 的 Goose 小节；两种方向不要混用。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人验证码或 Goose 配置批准使用 Web/交互式注册。需要 ACP 实时主通道时选择 `acp-goose` 的 `ACP → CLI → Pull`；只使用 Goose CLI 时选择 `goose` 的 `CLI → Pull`。

## 1. 安装前提

在启动 VOKO 的同一个用户和终端环境中确认：

```bash
goose --version
voko --version
```

Windows 下 VOKO 应解析到可执行的 `goose.exe`；如果刚安装 Goose 或修改了 `PATH`，请完全退出并重新启动 VOKO。当前已在 Windows Goose 1.38.0 上完成真实功能验证，但其他版本、操作系统和模型配置仍需自行复验。

Goose 自己的 Provider、模型和登录凭证必须先配置完成。VOKO 只负责调用 Goose，不代替 Goose 登录模型服务，也不会把模型 Token 写入 VOKO 配置。

Goose 配置和 session 目录必须对当前用户可读写。不要在 VOKO 运行期间手动移动、删除或修改 Goose session 数据。

## 2. 注册时选择通道

| VOKO Provider 类型 | 通道顺序 | 适用场景 |
| --- | --- | --- |
| `goose` | CLI → Pull | 只使用 Goose CLI，或暂不启用 ACP。 |
| `acp-goose` | ACP → CLI → Pull | 优先使用 ACP，ACP 进程不健康时自动降级 CLI。 |

Pull 始终是兜底通道。若把 Goose 配成 Pull-only，VOKO 不会主动推送回复。

注册完成后执行：

```bash
voko doctor --deep
voko get_status --agent-id=<agentId>
```

重点检查运行入口、当前活动通道，以及 `imConnection.connected/status`。Provider 入口可用不等于 IM Worker 已连接；这两个状态必须分别确认。

不要把 `backend_instance_id` 当作 Goose Instance。当前 Goose 路由使用 VOKO Agent、私聊/群聊类型、访客会话和 Goose 返回的原生 session ID；VOKO 不要求也不支持通过伪造 Instance 来隔离会话。

## 3. 会话和消息路由

### Caller identity for `whoami`

Goose documents `AGENT_SESSION_ID` as the native session identifier passed to local stdio extensions. VOKO reads it when Goose launches `voko mcp`; this works on Linux, Windows, and macOS when the extension process inherits the normal Goose environment. `backend_instance_id` remains a user-selected VOKO field and is not treated as a Goose instance. If the variable is absent or multiple Goose Agents share the same instance, VOKO does not inspect the newest session or run a handshake; use `voko_list_agents` and explicitly select the Agent.

VOKO 为每个以下组合保存独立绑定：

```text
(Agent, channelType, channelId)
```

绑定中保存 Goose 的真实原生 session ID。首次投递时 VOKO 会定位或创建 session；后续 CLI 和 ACP 都使用同一个原生 ID。不同 Agent、不同访客、私聊和群聊不会共享 session。

因此不要：

- 手动把一个访客的 session ID 填给另一个 Agent；
- 依赖“最近一个 session”或模糊名称续接；
- 在 VOKO 运行期间删除或重命名正在使用的 Goose session；
- 配置 `GOOSE_PATH_ROOT`、`GOOSE_SESSION_ID`，或创建虚假的 Goose Instance 以影响 VOKO 路由。

如果原生 session 已被外部删除或不可恢复，VOKO 会将旧绑定标记为 stale，并创建新的隔离 session；旧上下文不会凭空恢复。结果不明确时不会自动重复投递同一条消息。

## 4. ACP、CLI 降级和恢复

选择 `acp-goose` 时，路由行为是：

1. ACP 健康：消息走 Goose ACP。
2. ACP 进程退出、握手失败或被健康检查标记不可用：下一条消息走 Goose CLI。
3. ACP 健康检查或显式恢复成功：后续消息重新走 ACP。

切换只改变活动投递通道，不改变原生 session ID；不会因为 ACP → CLI → ACP 而重复回复。若 ACP 和 CLI 都不可用，消息保留在 VOKO，可由 Agent 通过 MCP/CLI 主动 Pull。

## 5. MCP 配置的方向说明

如果 Goose 需要调用 VOKO 工具，在 Goose 的 `extensions` 中配置 stdio：

```yaml
extensions:
  voko:
    enabled: true
    name: voko
    description: VOKO MCP 工具集
    display_name: VOKO MCP
    type: stdio
    cmd: voko
    args: [mcp]
    timeout: 300
```

也可以只对当前会话启用：

```bash
goose session --with-extension "voko mcp"
```

修改后完全退出并重启 Goose，再通过 `tools/list` 验证。不要把扩展 `url` 指向旧 Desktop 端口；优先使用 `voko mcp`，避免固定本地端口变化造成失效。

## 6. 排障顺序

1. `goose --version`：确认版本和 PATH。
2. `voko doctor --deep`：确认 VOKO 能解析 Goose CLI/ACP 入口。
3. `voko status --json`：确认 VOKO 实例正在运行。
4. `voko get_status --agent-id=<agentId>`：确认 IM Worker 已连接。
5. `goose session list --format json`：仅用于诊断 session 是否仍存在，不要在 VOKO 运行时直接清理活动 session。
6. 若自动通道不可用，先通过 Pull 读取消息，再处理 Provider 登录、权限或 session 状态。

Windows 终端编码不一致可能导致中文显示乱码；先统一终端为 UTF-8，再判断是否为 Provider 路由问题。模型回复被 VOKO 敏感内容审计拦截，也不等于 Goose 通道失败。

## 7. 验证边界和安全要求

当前已验证 Windows Goose 1.38.0 的：

- CLI 首次创建和原生 session ID 续接；
- ACP `newSession` / `loadSession`；
- ACP 终止后下一条消息单次降级 CLI；
- ACP 健康恢复后重新升级 ACP；
- ACP、CLI 切换期间保持同一原生 session ID。

这不等于所有 Goose 版本、模型、Provider 配置或操作系统都已完整回归。提交问题时只提供脱敏后的 VOKO 版本、Goose 版本、操作系统、通道和最小复现步骤；不要提供 Token、私密配置路径、原生 session ID 或完整访客提示词。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 Goose 1.45.0。
- 同一 Linux 用户完成 Goose 登录和 Voko 注册；CLI 首条消息与同一访客续接均通过，并保持同一原生 session binding。
- 推荐接收通道：`CLI → Pull`；本轮没有把 `backend_instance_id` 当作 Goose Instance，也没有设置 `GOOSE_PATH_ROOT`。
- 非交互 shell 必须继承 Goose 的模型/API 环境；profile 或 model 配置应在 Goose 自身配置中维护。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
