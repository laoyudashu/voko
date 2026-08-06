# Provider 专属指南

[文档索引](../README.md) · [兼容性矩阵](../provider-compatibility.md)

这些页面记录某一类 Agent 的安装、注册、投递通道、会话恢复和排障注意事项。它们补充而不是替代 [MCP、CLI 与本地运行模型](../mcp-cli-runtime.md) 中的通用流程。

需要先区分两种方向：

- **Agent → VOKO**：Agent 作为 MCP/CLI 客户端，调用 `voko mcp` 或 VOKO CLI。
- **VOKO → Agent**：VOKO 作为运行时，通过 Provider 的 ACP、HTTP、WebSocket 或 CLI 投递访客消息。

WorkBuddy 当前的专属配置属于第一种方向，继续放在 [MCP 客户端配置](../mcp-client-setup.md)；只有它作为 VOKO Provider 具备独立运行规则时，才需要新增 Provider 指南。

## 已有指南

- [Goose](goose.md)：Goose CLI、ACP、原生 session ID、CLI 降级和恢复。
- [OpenClaw](openclaw.md)：Gateway、实例选择、WebSocket、CLI 降级和 MCP 配置。
- [Hermes](hermes.md)：profile、HTTP API、CLI 降级和 Gateway 排障。
- [Codex](codex.md)：登录、只读 CLI、原生 thread ID 和 MCP 配置。
- [Claude Code](claude-code.md)：登录、只读 CLI、原生 session ID、Pull 兜底和 MCP 配置。

## 适合后续拆分的指南

以下 Provider 已有较充分的实现或实机验证资料，适合按同一模板继续拆分：

- Cline：ACP → Plan CLI → Pull、进程健康与恢复。
- Cursor Agent CLI：ACP、CLI `--resume` 以及 Windows 入口解析。
- ZeroClaw：ACP-over-WebSocket、ACP、CLI alias 和 state file 隔离。
- 其他尚未拆分的 Provider：按同一模板补充安装、注册、会话和降级说明。

尚未完成相应实机验收的 Provider，只应保留在兼容性矩阵的“待验证 / 环境受阻”说明中，不应提前写成可用操作保证。

## 新增指南时的固定结构

1. 安装、版本和 PATH 检查。
2. Provider 自身的登录、模型或服务配置。
3. VOKO 注册时应选择的 Provider 类型和通道顺序。
4. 会话/实例标识的真实语义，以及不可手动伪造的字段。
5. 主通道、降级通道、Pull 兜底和恢复条件。
6. 最小排障命令与已验证边界。
7. 凭证、私密配置、原生会话 ID 和日志脱敏要求。
