# Qwen Code 专属指南

[Provider 指南索引](README.md) · [统一注册与投递路由](../provider-delivery-routing.md) · [兼容性矩阵](../provider-compatibility.md)

本页针对 Qwen Code CLI 作为 **VOKO → Agent** Provider 的使用。Qwen Code 也可以作为 **Agent → VOKO** 客户端，通过 VOKO MCP 或 CLI 注册和读取消息；两种方向不要混淆。

## 快速路径

在安装并完成模型认证后，先确认入口：

```text
qwen --version
qwen --help
```

本机当前真机验证版本为 `0.21.7`。如果 `qwen` 不在 PATH，先修复 PATH，再重启 VOKO；不要在注册时手工填写一个猜测的可执行文件路径。

Qwen Code 的交互式认证入口以当前版本帮助为准。通常可在 `qwen` 交互界面中执行 `/auth`，并用 `/doctor` 检查模型、认证和 MCP 状态；旧版本的 `qwen auth` 子命令并不一定存在。无图形环境不要依赖浏览器 OAuth，使用已经配置好的 API 环境变量或在有浏览器的机器完成认证后再运行 VOKO。

## 模型与凭证

VOKO 的无头 CLI 路径读取现有进程环境，不把密钥拼接到命令行或日志。使用 DeepSeek 时可配置：

```powershell
$env:DEEPSEEK_API_KEY = '<从安全凭证存储注入>'
$env:DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
$env:DEEPSEEK_MODEL = 'deepseek-v4-flash'
```

也可以在用户环境变量或 Qwen Code 自己的配置中完成同等配置。不要把真实 Token 写进 Provider 文档、注册参数、截图或日志。

## VOKO 注册与推荐通道

在 Agent → VOKO 方向，优先调用 MCP 工具 `voko_manage_agent_registration`；MCP 不可用时使用 `voko manage_agent_registration --action start --registration-mode agent`。按注册状态机继续，不要伪造 `backend_instance_id` 或原生 session ID。

Provider 类型选择 `qwen-code`，推荐接收顺序为：

```text
cli -> pull
```

Qwen Code 当前在 VOKO 中没有 ACP、HTTP 或 WebSocket 主通道。`pull` 始终保留，是自动 CLI 不可用时的可靠兜底。注册后查看 `activeMode`、`availableModes`，并用 `voko doctor --deep` 或 `voko status --json` 确认 `qwen` 入口可用。

## VOKO 如何调用 Qwen Code

VOKO 通过 stdin 传入访客消息，并启用受限的 JSON 流输出。核心边界是：

```text
--auth-type openai --model <model>
--safe-mode
--approval-mode plan
--exclude-tools shell,write_file,replace,edit,agent
--max-tool-calls 0
--max-session-turns 4
--max-wall-time 120s
--output-format stream-json
```

这组参数只允许文字回答，不为外部访客消息预授权工具。Qwen 返回的原生 session ID 会保存到 VOKO 的会话绑定；同一 `(Agent、私聊/群聊、访客会话)` 后续使用 `--resume <session-id>`，不同会话不会共享绑定。不要在 Qwen 侧手工复制或修改这个 ID。

## 降级、恢复和 Pull

- CLI 入口不可用、认证失败或进程异常时，Dispatcher 刷新路由缓存并使用 `pull`。
- 修复 PATH、认证或模型配置并重启 VOKO 后，下一条消息重新检查 CLI。
- 投递结果不明确时不自动跨通道重发；先通过 Pull 确认，避免重复回复。
- 路由缓存按 Agent 保存；入口存在不等于当前进程健康。

## 真机验证边界

Windows 本机已验证 Qwen Code `0.21.7` 的：

- 受限无头 CLI 首次消息和 JSON 流最终回复；
- 相同原生 session 的续接；
- 无工具调用、无权限拒绝事件和退出码 0；
- 临时工作目录运行，不暴露凭证。

这属于真实 CLI/session 回路验证；ACP、HTTP、WebSocket 不适用于当前 Qwen Code Provider，MCP 注册仍以本机注册预检结果为准。

## 排障

```text
qwen --version
qwen --help
qwen                         # 交互界面内检查 /auth、/doctor
voko doctor --deep
voko status --json
```

若 VOKO 报入口不可用，先在同一用户、同一环境变量下直接运行 `qwen`；修改认证或 PATH 后必须重启 VOKO。日志只保留错误类别和退出状态，不应包含 Token、完整访客提示词、原生 session ID 或配置文件绝对路径。
