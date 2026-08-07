# Kiro CLI Provider 专属指南

[统一注册与投递路由规则](../provider-delivery-routing.md) · [文档索引](../README.md) · [Provider 指南索引](README.md) · [兼容性矩阵](../provider-compatibility.md) · [MCP 客户端配置](../mcp-client-setup.md)

本文说明 VOKO 调用 Kiro CLI 的安装、登录、注册、无交互使用和会话恢复。Kiro 作为 MCP 客户端调用 VOKO 时，按 [MCP 客户端配置](../mcp-client-setup.md) 单独配置。

> **Agent 快速选择**：Agent 自主注册优先使用 `voko_manage_agent_registration` MCP；主人验证码或配置批准使用 Web/交互式注册。Kiro 当前接收消息选择 `CLI → Pull`；登录或 PATH 未就绪时先保留 Pull。

## 1. 安装、版本和登录

在启动 VOKO 的同一个用户环境中确认：

```powershell
kiro-cli --version
kiro-cli whoami
Get-Command kiro-cli
```

本机实测 Kiro CLI `2.15.2`（可执行文件位于用户本地 Kiro-Cli 安装目录）。未登录时使用：

```powershell
kiro-cli login
```

无图形设备需要先在有图形的环境完成 Kiro 登录，再把同一用户的登录状态安全迁移；不要把登录缓存复制到日志、Agent 描述或仓库。

## 2. VOKO 注册

1. 启动 `voko start`，打开 `http://localhost:3100`，添加 Agent。
2. Provider 选择 **Kiro CLI**（协议值为 `kiro`）。Kiro 不需要 OpenClaw Agent ID、Hermes profile 或人为指定 Instance。
3. 推荐通道：

   ```text
   CLI → Pull
   ```

4. 完成后执行：

   ```powershell
   voko doctor --deep
   voko status --json
   ```

如果注册后运行中的 VOKO 仍只显示 Pull，重启一次 VOKO 以刷新路由缓存。

## 3. VOKO 的无交互安全边界

VOKO 使用临时工作目录和无交互模式，等价于：

```text
kiro-cli chat --no-interactive --trust-tools= --wrap never <prompt>
```

访客消息只允许产生文字回复，不会等待人工批准工具，也不会把 VOKO 项目目录当作 Kiro 工作区。Kiro CLI `2.15.2` 可能对空的 `--trust-tools=` 输出参数警告；本机实测该警告没有阻断 VOKO 的文字回路。不要为消除警告而自行放开工具权限；如果未来 Kiro 版本把它改为错误，应先升级 VOKO/Provider 或暂时使用 Pull。

## 4. 会话恢复

绑定范围固定为：

```text
(VOKO Agent, 私聊/群聊类型, 访客或群聊 ID)
```

首次 CLI 调用后，VOKO 从 Kiro 的 `chat --list-sessions --format json` 精确取得新会话 ID；后续消息使用 `--resume-id` 恢复。不同 Agent、访客、私聊和群聊不会共享 Kiro 会话。不要从 Kiro 会话列表手工猜测并填入 VOKO。

## 5. 最小验收

```powershell
voko probe --agent-id <agent-id> --visitor-id kiro-smoke-<date> --confirm `
  --message "Please reply with one short natural-language sentence confirming that Voko reached Kiro CLI." `
  --timeout 180
```

第二条消息使用同一个 `visitor-id` 验证 `--resume-id`：

```powershell
voko probe --agent-id <agent-id> --visitor-id kiro-smoke-<date> --confirm `
  --message "Continue the same conversation and confirm that the Kiro session was resumed." `
  --timeout 180
```

不要要求只返回全大写下划线标记，否则 VOKO 会按系统消息过滤。

本机 Windows 实测（Kiro CLI `2.15.2`，2026-08-06）：

- `kiro-cli whoami` 确认真实登录状态；
- 完成 Kiro Agent 注册并启用 CLI → Pull；
- 首条消息和同一访客续接均成功持久化为 `sent`；
- 未授予访客工具、写文件或 MCP 权限。

## 6. 常见问题

- `kiro-cli` 找不到：在启动 VOKO 的同一终端执行 `Get-Command kiro-cli`，把官方安装目录加入 PATH 后重启 VOKO。
- 登录状态丢失：运行 `kiro-cli whoami`；不要把另一个 Windows 用户的缓存直接混用。
- 只有 Pull：确认 `kiro-cli --version`、`whoami` 和 `voko doctor --deep`，再重启 VOKO。
- 会话续接失败：不要手工复用旧 session ID；让 VOKO 标记旧绑定失效并创建新的隔离会话。
- 终端出现 `--trust-tools` 警告：这是当前 Kiro CLI 版本对空权限参数的提示，不要以放开工具权限作为修复。

Kiro 登录缓存、配置、原生 session ID、访客原文和 CLI 日志不要提交到仓库或问题单。
