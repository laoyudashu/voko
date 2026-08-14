# A2A Mailbox Gateway 与 Lite Bridge

[文档索引](README.md) · [MCP/CLI 运行模型](mcp-cli-runtime.md) · [消息安全](message-safety.md)

VOKO 的 A2A Mailbox 将已发布的本地 Agent 映射为可从公网访问的 A2A 1.0 Agent，同时允许本地 Agent 发现并调用外部 A2A Agent。它是独立的数据面，不复用普通访客 IM、WuKongIM 消息或聊天 Conversation。

```text
外部 A2A Agent ⇄ AgentDID Mailbox Gateway ⇄ HTTPS 长轮询 ⇄ VOKO Lite ⇄ 本地 Provider
```

AgentDID 负责公网 Agent Card、鉴权、Task/Context、幂等、SSE、离线队列和远端调用；Lite 负责 Gateway 验签、安全审核、Provider Session 恢复、隔离执行和签名结果回传。Provider 原生 Session ID 只保存在本机。

## 启用与诊断

A2A 默认开启。正常产品流程由 VOKO 使用当前主人账号和已发布 Agent 自动注册设备；`VOKO_A2A_ENABLED=false`（或 `0`）仅用于整机紧急关闭。运维环境也可通过以下变量覆盖已保存配置：

```powershell
$env:VOKO_A2A_MAILBOX_URL='https://<gateway>/internal/a2a-mailbox/v1'
$env:VOKO_A2A_DEVICE_TOKEN='<device token>'
$env:VOKO_A2A_GATEWAY_PUBLIC_KEY_B64='<base64 public key>'
voko start
```

Linux/macOS 使用相同变量名。不要把 Token、Gateway 公钥配置或数据库提交到仓库。

Lite 使用独立的 `voko-a2a.db`，不会在主 `voko.db` 中创建 A2A Task 表。运行 `voko doctor` 可检查：模块是否启用、专用 Schema、Bridge 是否完成注册，以及待处理命令/事件数量；Doctor 不输出 Token、Mailbox URL、完整 ID、Provider Session 或本机数据库路径。

Web UI 的 `/a2a-tasks` 是独立任务页，也可以从 Agent 详情页的“A2A 任务”Tab进入并自动筛选当前 Agent。A2A Task 不进入普通访客会话列表，也不会自动创建好友关系。完整 Task/Event 历史以 AgentDID 为准；服务端不可用时，页面只显示 Lite 独立数据库中的恢复摘要。

发布到 VOKO、审核通过且主人有效的 Agent 自动获得 A2A 1.0 Agent Card 和 Endpoint，不再设置单独的 A2A 发布开关。`/agents/{agentId}/caps` 只维护业务资料和技能；空的 `skills` 合法。能力名称、描述和标签会映射为 A2A 1.0 `AgentSkill`；Skill ID 由 VOKO 稳定生成，文字 MVP 的输入输出模式固定为 `text/plain`。公开 Agent 可进入公开目录；私密 Agent 的匿名 Card 只暴露最小信息，完整资料需要认证并满足白名单策略；隐藏、下架、审核或主人状态无效时统一不可发现。

外部调用方在 AgentDID 中映射为稳定的 `remotePrincipalId`。该身份可以来自 VOKO Agent、DID、OAuth 主体、API 凭证、已验证 Card 密钥或稳定匿名凭证；请求正文中的自报 DID、名称、IP 和 User-Agent 均不能作为可信身份。Task 查询、取消和订阅始终限定在该身份作用域内。

## 本地 Agent 调用外部 Agent

通过 MCP 按以下顺序调用：

1. `voko_a2a_discover_agent`：传入当前 `agentId`、HTTPS Agent Card URL，以及可选 Bearer Credential。Gateway 会校验 A2A 1.0 HTTP+JSON Binding、DNS 与公网地址，并将凭证加密且按 Lite 设备和本地 Agent 隔离保存。
2. `voko_a2a_send_message`：传入相同 `agentId`、发现返回的 `remoteAgentKey` 和文字内容。相同 Idempotency Key 与相同请求复用原 Task；同键不同请求失败。
3. `voko_a2a_get_task`：使用 `agentId + taskId` 查询。Task 不能被另一个本地 Agent读取。
4. `voko_a2a_cancel_task`：请求取消同一 Agent 的 Task。只有远端明确返回取消才得到 `accepted`；`unsupported`、`too_late` 和 `outcome_unknown` 均不会伪装成成功，也不会自动重发取消请求。

当前外部调用只开放文字型 A2A 1.0 HTTP+JSON。外部 Artifact、Push Notification、直接 Lite 公网连接和 Provider 原生 Session 外传均未启用。

## 状态与可靠性

- 标准 Task 状态与投递状态分开；离线不是失败。
- Gateway SEND/HTTP 接收不等于 Provider 已执行；只有 Lite 签名事件才能推进到执行和完成状态。
- 网络结果不明确时保留 `DELIVERY_UNKNOWN`，不自动再次调用模型。
- 仅确认从未交付执行的离线 Task 在到期后转为 `FAILED / AGENT_UNAVAILABLE`。
- Lite 先将命令和结果写入独立 SQLite，再 ACK 或发送；重启后继续处理同一 event ID。
- 同一 `contextId` 恢复同一 Provider Session；不同 Context 不共享原生 Session。

## 安全边界

- Gateway→Lite 命令由 Gateway Ed25519 密钥签名，并同时校验到期时间、event ID、Agent 和 execution。
- Lite→Gateway 事件使用每个 Lite Agent 的本地 Ed25519 身份签名。
- 所有 A2A 入站/出站正文仍经过 VOKO 确定性审核和已启用的模型辅助分类器；A2A Reply Sink 不绕过安全策略。
- 外部发现拒绝 HTTP、重定向、私网/回环/保留地址和 DNS 重绑定目标。
- 远端凭证采用 A2A 专用密钥命名空间加密，并绑定到 `device + local Agent + remote Card`。
- `nativeSessionId`、Token、签名值、完整 Route、正文和本机路径不得进入 Doctor 或普通日志。

## 验证

Lite 自动化：

```bash
npm run typecheck
npm run build:ts
node --test test/a2a-*.test.js
```

AgentDID 在隔离 MySQL 和测试服务器上提供：

```bash
npm run test:a2a-e2e
npm run test:a2a-bridge-e2e
```

第二条测试会启动真实 Lite Bridge 组件，覆盖 HTTP 长轮询、签名、独立 SQLite Inbox/Outbox、隔离 Provider 调用和完成事件回传；其 Provider 是无副作用的可控测试实现。生产验收还必须用真实 Provider 和公网 HTTPS Gateway 完成双向测试。
