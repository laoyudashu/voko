# Aider 专属指南

[Provider 指南索引](README.md) · [统一注册与投递路由](../provider-delivery-routing.md) · [兼容性矩阵](../provider-compatibility.md)

本页针对 Aider 作为 **VOKO → Agent** Provider 的使用。Aider 也可以作为 **Agent → VOKO** 客户端，通过 VOKO MCP 或 CLI 注册和读取消息。

## 安装、版本和认证

确认入口：

```text
aider --version
aider --help
```

本机当前真机验证版本为 `0.86.2`。Aider 没有统一的 `aider login` 命令；模型凭证通过模型对应的 API 环境变量、Aider 配置文件或模型 Provider 自己的登录流程提供。使用 DeepSeek 时可准备：

```powershell
$env:DEEPSEEK_API_KEY = '<从安全凭证存储注入>'
$env:DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
$env:DEEPSEEK_MODEL = 'deepseek-v4-flash'
```

VOKO 会在子进程环境中映射为 `AIDER_MODEL=deepseek/<DEEPSEEK_MODEL>`，密钥不会拼接到命令行。若只在交互式 shell 中设置变量，必须确保启动 VOKO 的同一用户环境也能读取它。

## VOKO 注册与推荐通道

Agent → VOKO 优先使用 MCP 工具 `voko_manage_agent_registration`；备用入口为 `voko manage_agent_registration --action start --registration-mode agent`。Provider 类型选择 `aider`，推荐：

```text
cli -> pull
```

Aider 当前没有 VOKO ACP、HTTP 或 WebSocket 主通道。注册后检查 `activeMode`、`availableModes`，修改 PATH、环境变量或模型配置后重启 VOKO。

## VOKO 如何调用 Aider

VOKO 使用单次 `--message` 参数传入已净化的访客消息，并启用只读问答边界：

```text
--message <prompt>
--chat-mode ask
--dry-run --no-git --no-auto-commits
--no-auto-lint --no-auto-test
--no-browser --no-detect-urls
--no-suggest-shell-commands
--analytics-disable --no-check-update
--no-pretty --no-stream
```

Aider 的会话历史由 VOKO 按会话 ID 做 SHA-256 文件名隔离，保存到数据库旁的 `provider-sessions/aider/`；恢复消息时使用 `--restore-chat-history`。不要把这个路径、历史正文或原生模型输出复制到日志和工单。

同一 `(Agent、私聊/群聊、访客会话)` 只使用一个历史文件；不同会话不会共用。`backend_instance_id` 仍只是 VOKO 的实例配置字段，不是 Aider session ID。

## 降级、恢复和 Pull

- Aider 入口、模型凭证或进程失败时，Dispatcher 刷新路由缓存并使用 Pull。
- Aider 的 CLI 没有可用的 ACP 恢复事件；修复环境并重启 VOKO 后下一条消息重新探测。
- 结果不明确时不自动重发，因为 Aider 可能已经写入历史文件并生成回复。
- `dry-run` 只限制 Aider 的写入动作，不等于可以把不可信访客消息交给完整开发工作流；VOKO 仍通过提示词和参数关闭浏览、Shell 建议及自动测试。

## 真机验证边界

Windows 本机已验证 Aider `0.86.2` 的：

- DeepSeek 模型下的 ask/dry-run 无头单次回复；
- 相同托管历史文件的连续对话恢复；
- no-git、无自动提交、无浏览器和无 Shell 建议参数；
- 无 Windows 控制台时的正常退出（交互 prompt toolkit 警告可忽略）。

当前验证范围是真实 CLI/session 回路；Aider 没有已验收的 ACP、HTTP 或 WebSocket Push 通道。

## 排障

```text
aider --version
aider --help
voko doctor --deep
voko status --json
```

先在启动 VOKO 的同一环境中确认模型 API 可用，再检查 `AIDER_MODEL` 和 API key 是否被继承。不要把 key 放在 `--message`、进程列表、提交记录或日志中；日志也不应包含完整访客提示词、历史文件内容或绝对配置路径。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 Aider 0.86.2。
- 注册、首条消息和同一访客的续接均通过，推荐通道为 `CLI → Pull`。
- Linux 使用非交互 CLI 前先确认模型与凭据在 VOKO 启动环境可见；不要把 key 放入消息、参数或日志。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
