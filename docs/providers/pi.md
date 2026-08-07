# Pi Coding Agent 专属指南

[Provider 指南索引](README.md) · [统一注册与投递路由](../provider-delivery-routing.md) · [兼容性矩阵](../provider-compatibility.md)

本页针对 Pi Coding Agent 作为 **VOKO → Agent** Provider 的使用。Pi 也可以作为 **Agent → VOKO** 客户端通过 VOKO MCP 或 CLI 注册；注册入口和消息接收通道是两个独立概念。

## 安装、版本和认证

确认入口和版本：

```text
pi --version
pi --help
```

本机当前真机验证版本为 `0.84.0`。Pi 的认证方式取决于所选 Provider：启动交互界面后可在 Pi 内输入 `/login` 完成支持的 OAuth/订阅登录，也可以通过对应 API 环境变量或 Pi 配置完成认证。`/login` 不是 PowerShell 的 `pi /login` 命令；无图形环境应预先完成认证，或使用已注入的 API 环境变量，不要让 VOKO 等待浏览器登录。

使用 DeepSeek 时，VOKO 的受限 CLI 路径使用：

```text
--provider deepseek --model <DEEPSEEK_MODEL>
```

密钥从进程环境读取，绝不写入命令行参数和日志。示例环境变量名按本机凭证管理方式配置，不要把真实值写入文档。

## VOKO 注册与推荐通道

Agent → VOKO 优先使用 MCP 工具 `voko_manage_agent_registration`；备用入口为 `voko manage_agent_registration --action start --registration-mode agent`。Provider 类型选择 `pi`，推荐：

```text
cli -> pull
```

Pi 当前没有 VOKO ACP、HTTP 或 WebSocket 主通道。注册完成后检查 `activeMode`、`availableModes`，并在修改 PATH 或认证后重启 VOKO，再运行 `voko doctor --deep`。

## VOKO 如何调用 Pi

VOKO 使用 Pi 的 JSONL 非交互模式，并关闭可能访问本机资源的扩展面：

```text
--provider deepseek --model <model>
--no-tools --no-extensions --no-skills
-p --mode json
```

提示词通过 stdin 传入。首次运行由 VOKO 为逻辑会话生成托管 session ID，并通过 `--session-id <id>` 固定后续调用。相同 `(Agent、私聊/群聊、访客会话)` 使用相同绑定；不同 Agent 或访客不会复用。

不要将 Pi 的 session ID 当作 VOKO Agent instance，也不要在注册参数中手工填写它。原生会话绑定由 VOKO 保存和恢复。

## 降级、恢复和 Pull

- Pi CLI 不在 PATH、认证失败或退出异常时，路由缓存失效并使用 Pull。
- 修复环境后重启 VOKO，下一条消息重新检查 Pi CLI。
- 结果不明确时不跨通道重发；先通过 Pull 确认，避免一条访客消息产生两次回复。
- Pull 是正式兜底，不代表 Pi 注册失败。

## 真机验证边界

Windows 本机已验证 Pi `0.84.0` 的：

- `--mode json` 无头首次消息；
- `--session-id` 相同会话续接；
- `--no-tools --no-extensions --no-skills` 下无工具结果；
- 临时工作目录运行和正常退出。

当前验证范围是真实 CLI/session 回路；Pi 没有已验收的 ACP、HTTP 或 WebSocket Push 通道。

## 排障

```text
pi --version
pi --help
pi                            # 进入交互界面后输入 /login（需要 OAuth/订阅时）
pi auth --help               # 查看外部客户端凭证读取方式
voko doctor --deep
voko status --json
```

若 `/login` 返回 403，检查当前账号、Provider 和网络策略，不要把错误中的 Token 复制到日志或工单。修改认证、PATH 或模型配置后重启 VOKO。日志不应包含 API key、完整访客消息、session ID 或私人配置路径。
