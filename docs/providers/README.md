# Provider 专属指南

[文档索引](../README.md) · [统一注册与投递路由规则](../provider-delivery-routing.md) · [MCP、CLI 与本地运行模型](../mcp-cli-runtime.md) · [兼容性矩阵](../provider-compatibility.md)

这些页面记录已验收 Provider 的安装、注册、投递通道、会话恢复和排障注意事项。开始操作前，Agent 和操作者应先阅读[统一注册与投递路由规则](../provider-delivery-routing.md)，再阅读对应 Provider 页面；这里的专属文档只补充该 Provider 的特殊安装、登录、参数和安全边界。

需要先区分两种方向：

- **Agent → VOKO**：Agent 作为 MCP/CLI 客户端，调用 `voko mcp` 或 VOKO CLI。
- **VOKO → Agent**：VOKO 作为运行时，通过 Provider 的 ACP、HTTP、WebSocket 或 CLI 投递访客消息。

WorkBuddy 当前的专属配置属于第一种方向，继续放在 [MCP 客户端配置](../mcp-client-setup.md)；只有它作为 VOKO Provider 具备独立运行规则时，才需要新增 Provider 指南。

## Agent 如何选择文档

如果 Agent 正在注册 VOKO：

1. 先按[统一注册与投递路由规则](../provider-delivery-routing.md)选择注册入口：Agent 自主注册优先 MCP，MCP 不可用时使用 CLI；主人输入验证码或批准配置时使用 Web/交互式模式。
2. 读取 VOKO 注册预检返回的 `providerType` 和 `deliveryModes`，不要自行猜测类型或伪造 instance/session 字段。
3. 打开下方对应的专属指南，按“Agent 快速路径”和“VOKO 注册”章节操作。
4. 接收消息优先选择该 Provider 的推荐自动通道，`pull` 始终保留；修改 PATH、登录或配置后重启 VOKO 并重新检查状态。

## 已验收并提供指南的 Provider

- [Goose](goose.md)：Goose CLI、ACP、原生 session ID、CLI 降级和恢复。
- [Cline](cline.md)：Cline ACP、Plan CLI、工具权限边界、降级和恢复。
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

## 暂不提供专属指南的 Provider

Qwen Code、Aider、Pi、OpenHands、Gemini、Amazon Q、WorkBuddy、豆包和 Others 当前没有本目录下的专属操作指南。它们的状态只以[兼容性矩阵](../provider-compatibility.md)为准；“可检测”“功能设计”或局部功能验证不等于完成了可发布的专属操作验收。未完成验收前，不要依据本索引推断其自动 Push 可用。

## 新增指南时的固定结构

1. Agent 快速路径和两种方向（Agent → VOKO、VOKO → Agent）。
2. 安装、版本和 PATH 检查。
3. Provider 自身的登录、模型或服务配置。
4. VOKO 注册时应选择的 Provider 类型、注册模式和通道顺序。
5. 会话/实例标识的真实语义，以及不可手动伪造的字段。
6. 主通道、降级通道、Pull 兜底、健康事件和恢复条件。
7. 最小排障命令、已验证边界和凭证/日志脱敏要求。
