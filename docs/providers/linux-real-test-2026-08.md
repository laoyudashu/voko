# Ubuntu Linux Provider 实机验收矩阵（2026-08-07）

本页只记录 Linux 实机证据；通用 Transport 行为以 [Provider Transport 行为矩阵](../provider-transport-matrix.md) 为准。

这份记录补充各 Provider 专属指南中的 Windows 验收信息。测试机为 Ubuntu 24.04.4 LTS，使用当前源码构建的 VOKO Lite 0.4.3 npm 包；Voko 服务实际使用 Node 24.14.0，交互式 shell 的 Node 版本可能不同。所有 Agent 均在同一个 Voko 实例中完成注册、首条消息、同一访客第二条消息和消息持久化检查；日志只检查脱敏状态、通道和耗时，不记录 Token、完整访客提示词或原生 session ID。

## 结果总览

| Provider | Ubuntu 版本 | 注册与首条消息 | 同一会话续接 | 实际推荐通道 | Linux 特别说明 |
| --- | --- | --- | --- | --- | --- |
| OpenHands | CLI 1.14.0 / SDK 1.16.1 | 通过 | 通过 | Pull（当前 Catalog） | ACP/CLI 适配器曾完成验证，但当前未注册自动 Push transport |
| Goose | 1.45.0 | 通过 | 通过 | CLI → Pull | 使用 Goose 原生 session；不要设置 `GOOSE_PATH_ROOT` 冒充实例 |
| Codex | 0.145.0 | 通过 | 通过 | CLI → Pull | 先完成 `codex login`，保持只读无交互调用 |
| Claude Code | 2.1.220 | 通过 | 通过 | CLI → Pull | 先完成 `claude` 登录；非交互 shell 要继承同一用户环境 |
| Cline | 3.0.51 | 通过 | 通过 | ACP → CLI → Pull | ACP 首选；访客安全提示仍会拒绝未授权的高风险要求 |
| OpenCode | 1.18.9 | 通过 | 通过 | ACP → Attach → CLI → Pull | ACP 路径优先，Attach 需先启动受保护的 server |
| Cursor Agent | 2026.07.23-e383d2b | 通过 | 通过 | ACP → CLI → Pull | Voko 可解析官方用户安装目录，重启后刷新 PATH |
| GitHub Copilot | 1.0.76 | 通过 | 通过 | ACP → CLI → Pull | 先完成 OAuth；自然语言问候通过，外部访客的精确 Token 要求会被安全策略拒绝 |
| Kiro | 2.16.0 | 通过 | 通过 | CLI → Pull | 先完成 `kiro-cli login`/`whoami`；不要打开额外工具权限 |
| ZeroClaw | 0.8.3 | 通过 | 通过 | ACP → CLI → Pull | 本轮验收为 ACP；ACP-WebSocket 需另行配置 endpoint/token |
| Qwen Code | 0.21.1 | 通过 | 通过 | CLI → Pull | 命令为 `qwen`；无交互 shell 显式使用 `--auth-type openai` |
| Pi | 0.83.0 | 通过 | 通过 | CLI → Pull | 凭据由 `auth.json` 管理；模型/provider 需在同一用户环境可见 |
| Aider | 0.86.2 | 通过 | 通过 | CLI → Pull | 非交互调用前确认模型和 key 已在 Voko 启动环境中加载 |
| Grok | 0.2.118 | 通过 | 通过 | CLI → Pull | 使用无工具 Plan 调用；OAuth/API 配置不要写入 Voko 参数 |
| Gemini | 0.53.1 | 通过 | 通过 | CLI → Pull | Voko 使用 `--skip-trust` 与 Docker sandbox；无原生 binding，续接依赖 Voko context window |
| Reasonix | 1.21.0 | 通过 | 通过 | CLI → Pull | nvm 安装路径可被 Voko 自动发现；建议 `dontAsk`，不要使用 interactive plan |
| OpenClaw | 2026.6.1 | 通过 | 通过 | CLI → Pull（本次注册） | Gateway WebSocket 已连接，但本次 Agent 配为 CLI/Pull，故消息实际走 CLI；要用 WS 需注册对应模式 |
| Hermes | 0.19.1（2026-07-30） | 通过 | 通过 | CLI → Pull | Voko 自动解析 `~/.hermes/hermes-agent/.venv/bin/hermes`；profile 只填 profile 名称，不拼接 model |

## 通道和恢复规则

- 注册时应以 `voko register_agent`/MCP 预检返回的 `providerType`、`deliveryModes` 为准；不要手写或猜测 instance/session 字段。
- 本轮实测观察到：已注册的 Push 通道按配置顺序运行，健康事件后下一条消息可恢复，未出现重复投递；规范仍以 [Provider Transport 行为矩阵](../provider-transport-matrix.md) 为准。
- CLI Provider 的连续消息使用 Voko 保存的原生会话绑定；原生会话失效时只创建一次新会话，结果不明确时不自动重发。
- Gemini 是已验证的例外：当前 CLI 不提供可复用的原生 session ID，Voko 使用 context-window 历史续接；超时或上游 503 时不要立即重复发送。
- OpenClaw 的 Gateway WS、Hermes 的 HTTP profile 属于独立能力。运行时在线不代表当前 Agent 已选择该通道，须以 `voko doctor --deep` 的 active mode 为准。

## 本轮发现和修复

- Hermes：补充 Linux 官方 venv 可执行文件发现；修正 profile 列表解析；清理宿主进程中的通用 API key，避免覆盖 Hermes profile 认证。
- Gemini：headless 调用增加 `--skip-trust`，避免首次工作目录信任提示阻塞 Docker 模式。
- Runtime Resolver：Unix 下补充 `~/.local/bin`、`~/.local/share/pnpm`、`~/.cargo/bin`、`~/bin` 和 nvm Node bin 目录；`doctor --deep` 现在能在最小 PATH 环境中发现已安装 Provider。
- 首轮测试曾使用全大写下划线标记，触发 Voko 的系统消息保护过滤；正式验收统一使用自然语言提示，不修改该安全规则。

## 复测建议

```bash
voko doctor --deep
voko status --json
# 每个 Agent 使用自然语言发送首条消息，再在同一访客会话发送第二条消息
```

如果首条消息超时，先查看 `voko status --json`、Agent 消息记录和 Provider 自身登录状态；在结果不明确时不要重发同一条消息。
