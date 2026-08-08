# Reasonix 专属指南

[Provider 指南索引](README.md) · [统一注册与投递路由](../provider-delivery-routing.md) · [兼容性矩阵](../provider-compatibility.md)

本页针对 Reasonix CLI 作为 **VOKO → Agent** Provider 的使用。Reasonix 也可以作为 **Agent → VOKO** 客户端，通过 VOKO MCP 或 CLI 注册；本机当前没有预配置 Reasonix MCP Server，需按 Reasonix 自己的 MCP 配置方式另行添加。

## 安装、版本和认证

确认入口和运行状态：

```text
reasonix --version
reasonix --help
reasonix doctor --json
reasonix mcp list
```

本机当前真机验证版本为 `1.21.0`。`doctor --json` 应能看到可用模型、API host 和 key_present 状态；不要在日志中打印 key 值。Windows 常见配置位于用户目录下的 Reasonix 配置文件，但 VOKO 只依赖同一进程环境和 Reasonix 自己的配置解析，不要求手工填写该路径。

无图形环境请使用预先配置好的 API key/模型；`--permission-mode plan` 需要交互式会话，不适合 VOKO 无头投递。

## VOKO 注册与推荐通道

Agent → VOKO 优先使用 MCP 工具 `voko_manage_agent_registration`；备用入口为 `voko manage_agent_registration --action start --registration-mode agent`。Provider 类型选择 `reasonix`，推荐：

```text
cli -> pull
```

Reasonix 当前没有 VOKO ACP、HTTP 或 WebSocket 主通道。注册后运行 `voko doctor --deep` 和 `voko status --json`，确认 `reasonix` 可执行入口 ready。修改配置、模型或 PATH 后重启 VOKO。

## VOKO 如何调用 Reasonix

Reasonix 的无头调用必须把提示词写入 stdin，并使用：

```text
reasonix run --output-format stream-json --permission-mode dontAsk
```

注意：**不要在参数末尾追加单独的 `-`**。Reasonix `1.21.0` 会把这个 `-` 当作任务文本，从而忽略 stdin 中的访客消息。这是 VOKO 适配器已修复的关键差异。

`stream-json` 当前会先输出 `kind=text` 的增量，再输出 `type=result` 的最终结果；适配器同时兼容旧版 `type=text/data` 和 `run_done` 字段，避免把流式增量重复拼接。

`dontAsk` 适合无人值守：写入和动态 Shell 操作会被拒绝，不会等待交互式批准；只读检查仍可能被允许。因此 VOKO 还会在访客提示词前增加“只进行文本回答、不得调用工具或读写系统”的模型级边界。Reasonix 返回的 `session_id` 保存为 VOKO 会话绑定，续接使用：

```text
reasonix run --output-format stream-json --permission-mode dontAsk --resume <native-session-id>
```

原生 ID 由 VOKO 自动记录，不要把它当成 Provider instance 或手工复用到其他访客。会话唯一边界仍是 `(Agent、私聊/群聊、访客会话)`。

## 降级、恢复和 Pull

- Reasonix 入口不存在、认证失败、会话恢复失败或进程异常时，Dispatcher 刷新路由缓存并使用 Pull。
- 没有 ACP/HTTP/WS 健康事件，恢复通常依赖重启 VOKO 后的入口探测。
- 原生 session 恢复失败会标记旧 binding stale，并创建隔离的新会话；结果不明确时不自动重发。
- Pull 是正式兜底，消息仍保留在 VOKO，Agent 可主动读取。

## 真机验证边界

Windows 本机已验证 Reasonix `1.21.0` 的：

- `stream-json` stdin 首次消息和最终回复；
- `dontAsk` 无交互权限行为；
- 相同原生 session 的 `--resume` 连续对话；
- 修复尾部 `-` 后的 VOKO 参数兼容性。

当前验证范围是真实 CLI/session 回路；Reasonix 没有已验收的 ACP、HTTP 或 WebSocket Push 通道。本机 `reasonix mcp list` 当前为空，因此 Agent → VOKO 的 MCP 配置需要按实际部署另行完成。

## 排障

```text
reasonix --version
reasonix doctor --json
reasonix mcp list
voko doctor --deep
voko status --json
```

如果看到 `--permission-mode plan requires an interactive session`，说明用了不适合无头模式的权限档位；改用 `dontAsk`。如果 Reasonix 回复内容像固定的 `-`，检查调用方是否错误地把 `-` 放在参数末尾。日志不得包含 Token、完整访客提示词、原生 session ID 或 Reasonix 私有配置路径。

## Ubuntu Linux 实机验收（2026-08-07）

- 环境：Ubuntu 24.04.4 LTS；Voko 0.4.3 由当前源码构建；实测 Reasonix 1.21.0。
- Reasonix 安装在 nvm 用户目录；Voko Runtime Resolver 可自动发现该路径。注册、CLI 首条消息和同一访客续接均通过。
- 推荐接收通道：`CLI → Pull`；无图形模式使用 `dontAsk`，不要使用要求 interactive session 的 plan 权限模式。
- 旧版 doctor 在最小 PATH 下可能误报缺少 Linux 包；升级 Voko 0.4.3 后重新运行 `voko doctor --deep`。
- [完整 Linux 验收矩阵](linux-real-test-2026-08.md)
