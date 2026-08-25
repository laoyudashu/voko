# Provider 专属指南

[文档索引](../README.md) · [Transport 行为矩阵（架构真相源）](../provider-transport-matrix.md) · [统一注册与投递路由规则](../provider-delivery-routing.md) · [Provider 调用方身份与 Session 证据](../provider-caller-identity.md) · [MCP消息与精确Conversation接口](../mcp-message-conversations.md) · [MCP、CLI 与本地运行模型](../mcp-cli-runtime.md) · [兼容性矩阵](../provider-compatibility.md)

开发新的 Provider 时，先阅读[新增智能体框架开发指南](../adding-provider.md)。专属指南只在对应 Provider 完成真实安装、注册、消息、Session、降级和恢复验收后创建。

这些页面只记录已验收 Provider 的差异：安装、登录、版本、实例/Session 语义、特殊参数、安全限制和已验证边界。通用通道顺序、Binding、结果分类、路由缓存和恢复规则统一阅读[Transport 行为矩阵](../provider-transport-matrix.md)；注册和操作者排障统一阅读[统一注册与投递路由规则](../provider-delivery-routing.md)。专属页面不得复制完整通用路由章节。

需要先区分两种方向：

- **Agent → VOKO**：Agent 作为 MCP/CLI 客户端，调用 `voko mcp` 或 VOKO CLI。
- **VOKO → Agent**：VOKO 作为运行时，通过 Provider 的 ACP、HTTP、WebSocket 或 CLI 投递访客消息。

WorkBuddy 同时支持两个方向：作为 MCP 客户端调用 VOKO，以及由 VOKO 通过本机 HTTP API 自动投递。后者见 [WorkBuddy 专属指南](workbuddy.md)。

## Agent 如何选择文档

如果 Agent 正在注册 VOKO：

1. 先按[统一注册与投递路由规则](../provider-delivery-routing.md)选择注册入口：Agent 自主注册优先 MCP，MCP 不可用时使用 CLI；主人输入验证码或批准配置时使用 Web/交互式模式。
2. 读取 VOKO 注册预检返回的 `providerType` 和 `deliveryModes`，不要自行猜测类型或伪造 instance/session 字段。
3. 打开下方对应的专属指南，按“Agent 快速路径”和“VOKO 注册”章节操作。
4. 接收消息优先选择该 Provider 的推荐自动通道，`pull` 始终保留；修改 PATH、登录或配置后重启 VOKO 并重新检查状态。
5. 通过MCP收发消息时遵循[统一消息接口契约](../mcp-message-conversations.md)：具体回复优先传`replyToMessageId`，多Session选择才显式传`conversationId`。

## 已验收并提供指南的 Provider

- [Goose](goose.md)：Goose CLI、ACP、原生 session ID、CLI 降级和恢复。
- [Cline](cline.md)：Cline ACP、Plan CLI、工具权限边界、降级和恢复。
- [OpenHands](openhands.md)：OpenHands CLI 1.16.0 / SDK 1.21.0 的 ACP/CLI 适配器验证；当前 Catalog 仍为 Pull-only。
- [OpenClaw](openclaw.md)：Gateway、实例选择、WebSocket、CLI 降级和 MCP 配置。
- [Hermes](hermes.md)：profile、HTTP API、CLI 降级和 Gateway 排障。
- [Codex](codex.md)：登录、只读 CLI、原生 thread ID 和 MCP 配置。
- [Claude Code](claude-code.md)：登录、只读 CLI、原生 session ID、Pull 兜底和 MCP 配置。
- [OpenCode](opencode.md)：ACP、CLI、临时工作目录、模型凭据和会话恢复。
- [Cursor Agent CLI](cursor-agent.md)：官方运行入口解析、ACP、Plan CLI 和 `--resume`。
- [GitHub Copilot CLI](github-copilot.md)：OAuth 登录、ACP 安全参数、会话续接和 Pull 兜底。
- [Kiro CLI](kiro.md)：无交互 CLI、登录检查、`--resume-id` 和工具权限边界。
- [ZeroClaw](zeroclaw.md)：Agent alias、ACP、CLI state file 隔离和配置安全。
- [Grok CLI](grok.md)：OAuth/API 配置、无工具 Plan CLI、原生 session 和代理检查。
- [Qwen Code](qwen-code.md)：无头 safe/plan CLI、DeepSeek 配置、原生 session 续接和 Pull 兜底。
- [千问办公](qwen-office.md)：专家套件发现与精确实例绑定、`qoderclicn` stream-json CLI、session 续接和 Pull 兜底。
- [百度搭子](dumate.md)：用户 Plugin Pack 发现、Plugin Part 精准路由、原生 session Resume 和 fail-closed 校验。
- [Trae](trae.md)：Trae MCP 客户端配置、独立 `traecli` ACP、桌面入口边界和 Pull 兜底。
- [Pi Coding Agent](pi.md)：无工具 JSONL CLI、托管 session、认证和 Pull 兜底。
- [Aider](aider.md)：ask/dry-run 只读 CLI、哈希历史文件、模型配置和 Pull 兜底。
- [Reasonix](reasonix.md)：stdin、stream-json、dontAsk 权限、原生 session 和尾部参数注意事项。
- [WorkBuddy](workbuddy.md)：桌面版内置 CodeBuddy HTTP、SSE、精确会话、取消和 Pull 兜底。

## 暂不提供专属指南的 Provider

Amazon Q、ZCode、豆包、CodeBuddy、DeepSeek Harness 和 Others 当前没有本目录下的专属操作指南。CodeBuddy 已接入官方 ACP 并完成无模型协议初始化；DeepSeek Harness 已接入可恢复的 Web Host 与单次任务 Profile CLI，但模型回复、访客安全配置和 Owner 介入仍待验收，完整结论以[兼容性矩阵](../provider-compatibility.md)为准。WorkBuddy、千问办公和 Trae 已有专属页面；它们的 Push 通道均依赖本机运行时预检，不满足前置条件时才回退 Pull。“可检测”“功能设计”或局部功能验证不等于完成了可发布的专属操作验收。

## 新增指南时的固定结构

1. Agent 快速路径和两种方向（Agent → VOKO、VOKO → Agent）。
2. 安装、版本和 PATH 检查。
3. Provider 自身的登录、模型或服务配置。
4. VOKO 注册时应选择的 Provider 类型、注册模式和通道顺序。
5. 会话/实例标识的真实语义，以及不可手动伪造的字段。
6. 该 Provider 独有的主通道/备通道差异、健康限制和恢复前提（通用规则不要重复）。
7. 最小排障命令、已验证边界和凭证/日志脱敏要求。

## 2026-08 Ubuntu Linux 实机验收补充

Gemini 已完成 Ubuntu 真实注册、首条消息和同一访客续接，并新增 [Gemini 专属指南](gemini.md)。原有“暂不提供专属指南”段落是历史快照，以本条和新指南为准；其他未列入“已验收并提供指南”的 Provider 仍不要按此矩阵推断其 Push 可用性。

18 个已验证 Provider 的版本、注册结果、推荐接收通道、降级与路由缓存说明集中在 [Ubuntu Linux 实机验收矩阵](linux-real-test-2026-08.md)。
