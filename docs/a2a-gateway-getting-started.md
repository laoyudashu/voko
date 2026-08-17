# A2A Gateway 上手指南（面向 A2A 用户）

[文档索引](README.md) · [A2A Mailbox Gateway 与 Lite Bridge](a2a-mailbox.md) · [MCP/CLI 运行模型](mcp-cli-runtime.md)

## 这个功能解决什么问题

你在本地运行 VOKO，想让外部系统或外部 Agent 按标准协议调用你的本地能力，但不想直接改造本地网络、也不想把每个 Provider 开成公网服务。

A2A Gateway 的作用就是：

1. 把你的本地 Agent 映射为标准 `A2A 1.0` 的能力入口。
2. 通过一个安全网关（公网可达）把任务交给本机处理。
3. 保留本地执行隔离，不让外部系统直接接触 Provider Session 或本地路径。

一句话说法：

> 你负责本地执行能力，Gateway 负责把它变成“可被外部标准调用”的服务。

## 适用场景

适合你的场景有：

1. 你想让本地 Agent 被其他业务系统调用（如另一台机器的 Agent、外部 A2A 平台）。
2. 对方不能接入你的 VOKO IM（WuKongIM）时，仍要有标准接口。
3. 你需要任务级可靠性（离线、重启可恢复、事件可查询）。
4. 你希望保持 VOKO 现有权限策略（公开/私密/下架/黑白名单）不变。

不适合的场景：

1. 仅在本机和访客 IM 内部沟通，不需要公网可发现能力。
2. 只想做一次性脚本调用，不需要任务可追踪、可审计。

## 核心架构（你可以直接理解为三层）

```text
外部 A2A 系统 ⇄ AgentDID Mailbox Gateway（HTTPS）⇄ HTTPS 长轮询 ⇄ VOKO Lite ⇄ 本地 Provider
```

你可以把它理解成：

- Gateway：公网入口，负责身份、任务状态、队列、失败恢复。
- Lite：本地执行器，负责调用本地 Provider，并签名回传结果。
- 本地数据库：A2A 任务状态保存在 `voko-a2a.db`，与 IM 的主库（`voko.db`）隔离。

## 你会看到的几个关键名词

- `Task`：一次外部调用任务。
- `Context`：同一个对端长期会话空间。
- `executionId`：一次具体执行链路的唯一标识。
- `conversation`：这里优先按 `contextId + taskId` 管理，避免混淆。
- `deliveryState`：是否送达本地执行层的中间状态（如排队/送达/不明）。

## 你要怎么使用

对于“刚开始接入”的流程：

1. 确保 Agent 已发布并通过 VOKO 审核策略。
2. 开启 A2A（默认开启，紧急关闭：`VOKO_A2A_ENABLED=false`）。
3. 用外部系统按你的 `agent card` URL 发现能力。
4. 按 A2A 1.0 发送消息，网关返回 `task` 或消息。
5. 通过 `GetTask / Subscribe` 查询状态与结果。

更细的实现字段、状态边界和安全行为，请继续看：

- [A2A Mailbox Gateway 与 Lite Bridge（实现细节）](a2a-mailbox.md)

## 与 VOKO 其他场景的关系

- 不会混入普通访客聊天列表，也不会自动建立好友关系。
- 不会走 IM 的 `conversation` 与群聊路由。
- 公开/私密/隐藏/下架、黑白名单仍按 VOKO 既有规则执行。
- 本地核心安全策略（关键词审计、人工介入、模型辅助复核）会继续生效。

## 常见问题（FAQ）

1. 外部调用了为什么没有立刻看到最终结果？
   - 任务会经过入库、排队、执行、事件回传；可通过 `GetTask` / `Subscribe` 查询。

2. 为什么会看到 `deliveryState=DELIVERY_UNKNOWN`？
   - 常见于执行结果短时不可确认；表示任务已进入不确定阶段，不等于最终失败。

3. 同一 context 为什么不是单条回复？
   - A2A 与 Task/Context/消息是任务级语义，正常会产生多段状态更新。

4. 是否会泄露 `token/session/本机路径`？
   - 不会；Gateway/Lite 会脱敏，不在任务正文和 UI 中展示敏感执行细节。

## 快速对接检查清单

- Agent 已发布且可被发现（公开/私密策略已生效）。
- Gateway URL 可用且证书链正常。
- 对端使用 A2A 1.0 HTTP+JSON。
- 你有对端凭证对应的授权规则。
- 出现 `TaskNotFound`/`403/404` 时，先确认是否是身份作用域或策略差异。

## 我现在该看什么

- 你是第一次使用：先看本页。 
- 你要对接具体行为（签名、队列、幂等、状态码映射）：看 [A2A Mailbox Gateway 与 Lite Bridge](a2a-mailbox.md)。
