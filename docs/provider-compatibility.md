# Provider / 智能体兼容性与实测结果

[Documentation index](README.md) · [Provider Transport behavior matrix](provider-transport-matrix.md) · [Provider registration, delivery, and route recovery](provider-delivery-routing.md) · [Provider-specific guides](providers/README.md)

此页面向使用 VOKO 的普通用户，说明本地 Agent 如何接入、VOKO 如何把新消息交给 Agent，以及当前证据的边界。它不是对所有 Provider 版本、账号计划、操作系统、模型配置或网络环境的保证。

通用架构不变量见[Provider Transport 行为矩阵](provider-transport-matrix.md)，注册和操作者路径见[Provider 注册、消息投递与路由恢复指南](provider-delivery-routing.md)。本页只保留各类型的能力矩阵和验收证据；未完成验收的类型不要按照矩阵中的“可检测”推断为已支持自动推送。

所有表中“Agent → VOKO”均表示 Agent 可通过 VOKO MCP、CLI 或本机接口完成注册、发消息和主动读取；实际可用入口取决于你的宿主环境。所有“主 / 备”通道都只有在本机检测可用、且你在注册时启用后才会使用。**Pull 始终保留**：消息会留在 VOKO，Agent 可通过 VOKO CLI、MCP 工具或本机接口主动读取；这不是投递错误。消息工具的`conversationId`发现、精确历史、发送与兼容规则统一见[MCP消息与精确Conversation接口](mcp-message-conversations.md)。

从 `v0.5.1` 起，自动投递统一使用连续消息 Turn 和精细结果状态。矩阵中的“连续对话”同时要求同一会话的消息不串到其他 Agent、访客、群或 Conversation；“发送成功”与 Provider 执行、回复结果分别记录，不能只用本地入库代替真实回路结论。

| 智能体名称 | Agent 向 VOKO 发消息 | VOKO 向 Agent 收 / 推新消息（主 → 备 → 兜底） | 会话连续性 / 重启恢复 | 实测结论 | 备注 |
| --- | --- | --- | --- | --- | --- |
| OpenClaw | MCP、CLI、本机接口 | WebSocket → OpenClaw CLI → Pull | 实例隔离、连续对话和通道降级已回归 | 真机完整回归 | `backend_instance_id` 选择 `openclaw.json` 中的 Agent ID；Windows OpenClaw 2026.6.1 实测；详见 [OpenClaw 专属指南](providers/openclaw.md)。 |
| Hermes | MCP、CLI、本机接口 | HTTP → Hermes CLI → Pull | profile 隔离、连续对话和通道降级已回归 | Windows + Ubuntu 真机完整回归 | `backend_instance_id` 是 Hermes profile；Ubuntu Hermes 0.19.1、Windows 0.19.0；Linux 可自动发现官方 venv 入口；详见 [Hermes 专属指南](providers/hermes.md)。 |
| Goose | MCP、CLI、本机接口 | `acp-goose`: ACP → CLI → Pull；`goose`: CLI → Pull | Goose 原生 session ID 在 CLI/ACP 间保持；ACP 断开后可降级并恢复 | Windows 实机 ACP→CLI→ACP 与 CLI 会话验证 | Windows Goose 1.38.0；直接启动 `goose.exe`，提示词经 stdin 传入；详见 [Goose 专属指南](providers/goose.md)。 |
| Codex | MCP、CLI、本机接口 | Codex CLI（thread / session）→ Pull | 发送、回复、原生恢复已验证；按会话隔离 | Windows 实机 CLI 会话验证 | 可选择 `CODEX_HOME` 下 `<name>.config.toml` 对应的 Profile；Profile 是启动配置，不是 thread/session。使用 `codex exec --json --sandbox read-only`；详见 [Codex 专属指南](providers/codex.md)。 |
| Claude Code | MCP、CLI、本机接口 | Claude Code CLI 持久会话 → Pull | 连续对话与原生 session 恢复已验证 | Windows 实机 CLI 会话验证 | 可选择 `~/.claude/agents/*.md` Agent，并从 frontmatter 生成可编辑资料建议；托管路径禁用工具、Chrome、项目指令和写操作；详见 [Claude Code 专属指南](providers/claude-code.md)。 |
| OpenCode | MCP、CLI、本机接口 | ACP / attach（已配置服务时）→ OpenCode CLI → Pull | ACP/CLI 指定会话、连续对话和恢复已验证；Attach 完成入口预检 | Windows 真机 ACP/CLI 会话验证 | 可选择 `~/.config/opencode/agents/*.md` Agent；ACP、attach 与 CLI 是独立路径；保留角色隔离与权限约束；详见 [OpenCode 专属指南](providers/opencode.md)。 |
| Cursor Agent CLI | MCP、CLI、本机接口 | Cursor ACP → Cursor CLI（`--resume`）→ Pull | ACP、CLI 原生恢复和连续对话已验证 | Windows 真机 ACP/CLI 会话验证 | 官方运行入口解析；ACP 工具默认拒绝，CLI 使用只读 plan 模式；详见 [Cursor 专属指南](providers/cursor-agent.md)。 |
| Kiro CLI | MCP、CLI、本机接口 | Kiro CLI（Hook session / `--resume-id`）→ Pull | 首次会话、精确 session 识别和续接已验证 | Windows 真机 CLI 会话验证 | 非交互、无预授权工具模式；详见 [Kiro 专属指南](providers/kiro.md)。 |
| GitHub Copilot CLI | MCP、CLI、本机接口 | ACP → 受限 Copilot CLI → Pull | ACP 隔离会话、连续对话和受限 CLI 备选配置已覆盖 | Windows 真机 ACP/续接验证 | 可选择 `~/.copilot/agents/*.md` Agent，并从 frontmatter 生成可编辑资料建议；禁用自定义指令、内置 MCP、远程导出和自动更新；工具白名单为空；详见 [Copilot 专属指南](providers/github-copilot.md)。 |
| Qwen Code | MCP、CLI、本机接口 | Qwen CLI → Pull | 原生 session 与 `--resume` 恢复已验证 | Windows 真机 CLI/session 验证 | Qwen Code 0.21.7；safe/plan、零工具预算和受限 stdin；详见 [Qwen Code 专属指南](providers/qwen-code.md)。 |
| Aider | MCP、CLI、本机接口 | Aider ask 模式 CLI → Pull | 隔离、哈希命名的历史文件可恢复 | Windows 真机 CLI/session 验证 | Aider 0.86.2；ask/dry-run、no-git、无浏览器和无 Shell 建议；详见 [Aider 专属指南](providers/aider.md)。 |
| Cline | MCP、CLI、本机接口 | Cline ACP → Cline Plan CLI → Pull | ACP 隔离会话；CLI `--json` JSONL 输出已适配；ACP 退出后可健康恢复 | Windows 实机 ACP→CLI→ACP 回路验收 | ACP 使用 `cline --acp`；CLI 使用 plan/JSONL 模式并拒绝外部访客工具权限；CLI 需要先完成 `cline auth`。 |
| Pi Coding Agent | MCP、CLI、本机接口 | Pi CLI → Pull | `--session-id` 原生 session 恢复已验证 | Windows 真机 CLI/session 验证 | Pi 0.84.0；no-tools、no-extensions、no-skills；详见 [Pi 专属指南](providers/pi.md)。 |
| Reasonix | MCP、CLI、本机接口 | Reasonix CLI → Pull | `session_id` 与 `--resume` 原生恢复已验证 | macOS 1.27.0 与 Ubuntu 1.29.0 真机核验 | positional task + `stream-json` + `dontAsk`；允许本地读取和 Provider Web，拒绝未批准的写入与 Shell；详见 [Reasonix 专属指南](providers/reasonix.md)。 |
| Grok CLI | MCP、CLI、本机接口 | Grok CLI → Pull | 原生 session 绑定、连续对话和恢复已验证 | Windows 真机 CLI 会话验证 | Windows loopback proxy 可映射；plan、无工具、禁 web / subagents / memory、单轮；详见 [Grok 专属指南](providers/grok.md)。 |
| OpenHands | MCP、CLI、本机接口 | Pull（当前 Catalog） | ACP/CLI 适配器首次、续接和 ACP→CLI→ACP 往返已验证，尚未注册为自动 Push | Windows 适配器真机验证 | OpenHands CLI 1.16.0，启动时显示 SDK 1.21.0；CLI 禁用终端、文件、浏览器、MCP、网络和子代理工具；详见 [OpenHands 专属指南](providers/openhands.md)。 |
| ZeroClaw | MCP、CLI、本机接口 | ACP-over-WebSocket → ACP → CLI（alias + 独立 state file）→ Pull | ACP WebSocket 原生 session、连续对话和恢复已验证；CLI fallback 配置预检通过 | Windows ZeroClaw 0.8.3 真机 ACP-WebSocket 回路验证 | 网关使用本机回环 `/acp`、配对 Bearer token 和 `zeroclaw.acp.v1`；角色隔离与会话别名受保护；详见 [ZeroClaw 专属指南](providers/zeroclaw.md)。 |
| Gemini CLI | MCP、CLI、本机接口 | 安全沙箱 CLI（需 Docker）→ Pull | Ubuntu Docker sandbox 首条消息和同一访客续接已验证；当前使用 VOKO context window，不保存原生 binding | Ubuntu 24.04.4 真机完整回归 | Gemini CLI 0.53.1；headless 使用 `--skip-trust`，首次 Docker/上游高负载可能较慢；详见 [Gemini 专属指南](providers/gemini.md)。 |

Ubuntu 24.04.4 LTS 的 18 个 Provider 版本、注册结果、推荐通道和限制见 [Linux 实机验收矩阵](providers/linux-real-test-2026-08.md)。矩阵是当前 Linux 实机证据的集中记录；Windows 版本和路径说明仍保留在各 Provider 条目与专属指南中。

## 已识别但 Push 运行时依赖本机条件的集成环境

这些环境可被识别，Agent 仍可通过 MCP 或本机接口与 VOKO 通信；QwenWork 和 Trae 已注册可选 Push 运行时，但只有本机预检通过后才启用，否则保留 Pull。

| 类型 | VOKO → Agent | 当前结论 | 说明 |
| --- | --- | --- | --- |
| Amazon Q | Pull | 待验证 | 尚未确认 Windows / Ubuntu 当前版本是否具备稳定且可限制权限的非交互模式。 |
| 千问办公（QwenWork） | 精确专家套件 CLI → Pull | 旧版完整链路已验收；当前版专家套件发现与路由已做无模型验证 | QwenWork 0.1.6 / qoderclicn 1.0.47 已验证随机 challenge、真实 IM、模型回复、SENDACK、单次落库及 A2A 收敛。QwenWork 0.1.8 / qoderclicn 1.1.18 已验证两套本地专家套件发现、插件清单和 `--cwd` + `--plugin-dir` 路由；新版真实模型回路仍需显式执行“验证消息链路”。详见 [千问办公专属指南](providers/qwen-office.md)。 |
| 百度搭子（DuMate） | 精确 Agent HTTP → Pull | Plugin Pack 发现、私有临时精准路由、Plugin Part 激活和原生 Session Resume 已接入 | 可绑定 `.claude-plugin/plugin.json` 对应的稳定 Agent ID，也可不绑定并由 VOKO 创建按 Agent 隔离的临时路由；独立本机回环 `dumate-opencode` 服务会复核 `activePlugins`，实例或会话不一致时 fail closed。ACP 最终消息映射尚不足以作为生产主通道。详见 [百度搭子专属指南](providers/dumate.md)。 |
| Trae / TraeWork | Trae CLI ACP → Pull | 已接入（桌面 MCP 客户端 + 独立 traecli ACP） | 本机 TraeWork CN 0.1.51、Trae CLI 0.120.52；ACP initialize 与 DeepSeek 配置识别通过，但当前 Enterprise 发行版首次模型请求仍要求不存在的企业 Keyring 凭证，模型回复/续聊待验收。桌面会话不作为 Push 目标；详见 [Trae 专属指南](providers/trae.md)。 |
| WorkBuddy | HTTP → Pull | macOS 全局 CLI 2.139.0 真实回路已验证；Windows 登录后回路待验收 | 自动投递要求单独安装 `@tencent-ai/codebuddy-code`、执行一次 `codebuddy /login` 并通过真实 loopback。VOKO 优先使用全局新版 CLI，桌面内置旧版仅作回退；服务只监听 `127.0.0.1`，支持 ACP 流式回复、精确会话和取消。HTTP API 仍属 Beta，启动时会复核实际契约。 |
| DeepSeek Harness | Web Host HTTP → Profile CLI → Pull | 已接入；本机 rc.7 启动和 API/preset 发现已验证，模型回路待验收 | Web Host 使用 `backend_instance_id` 对应的 `agentPreset` 和持久 Session ID 精确路由。Profile CLI 支持自定义 profile（默认 `headless`），但内置 headless 每次创建新 Agent，只用于无绑定的单次任务。ACP fresh Session 和 CLI one-shot 均不参与恢复或 Owner 介入。内置配置含本机工具，不等于 VOKO-safe 访客配置。 |
| CodeBuddy | ACP → Pull | 官方 ACP 初始化已验证，模型回路待独立 CLI 真机验收 | VOKO 只检测独立安装的 `@tencent-ai/codebuddy-code` / `codebuddy`，不把 WorkBuddy 内置 CLI 当成 CodeBuddy；ACP 禁用工具并忽略外部 MCP 配置。 |
| 豆包等无可靠自动入口的桌面 Agent | Pull | 仅检测 / 按宿主集成 | 请让 Agent 用 VOKO CLI、MCP 或本机接口主动获取新消息。 |

## 会话、安全与降级规则

- Provider 会话绑定只保存在本机 `voko.db`，不会上传 AgentDID；Web UI、MCP 响应和日志不会暴露完整原生会话 ID。
- 每个 VOKO Agent 与每个私聊 / 群聊独立绑定。无法可靠识别原生会话时，VOKO 不猜测“最近会话”，而是创建 VOKO 托管的隔离会话。
- 原生恢复失败时，VOKO 会标记旧绑定为 stale，在当前 Agent 的 Provider 路由范围内创建新的托管会话并注入必要本地历史；随后尝试其他已启用通道，最终保留 Pull。消息不会因降级而丢失或重复投递。
- “真机完整回归”表示已在说明所列真实本机环境完成收发、连续对话、恢复与降级的组合验证；“真机功能验证”或“功能 / 会话验证”只覆盖所列路径；“待验证 / 环境受阻”与“仅检测”不代表自动推送可用。

## Contribute a result

Open a public [GitHub Issue](https://github.com/laoyudashu/voko/issues) for a non-sensitive compatibility report, or include it in a pull request for an adapter change. Provide:

1. VOKO version and operating system/version.
2. Provider name, version, and connection mode.
3. The minimum reproduction steps and the observed result.
4. Sanitized logs only; never include credentials, tokens, private keys, verification codes, session IDs, or private conversations.

Use the local Web UI's Report a bug page for product issues that benefit from the built-in report flow; run `voko status --json` first to find the active local port. See [Contributing](../CONTRIBUTING.md) for code changes.
