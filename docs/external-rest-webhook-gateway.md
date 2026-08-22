# External REST/Webhook Gateway

[文档索引](README.md) · [A2A Gateway](a2a-gateway-getting-started.md) · [消息安全](message-safety.md)

External Gateway 让不支持 VOKO IM 或 A2A 的传统系统调用本地 Agent。典型调用链是：

```text
CRM / 工单 / 自动化平台
  ── REST + API Token ──▶ AgentDID Gateway
  ── 可靠 Mailbox ──▶ VOKO Lite ──▶ 本地 Provider
  ◀── HTTPS Webhook + 签名 ── AgentDID Gateway
```

它适合 CRM、工单系统、CI/CD、监控告警、业务后台和自建服务。若双方都支持标准 A2A 1.0，应优先使用 [A2A Gateway](a2a-gateway-getting-started.md)，以获得标准 Task、Context 和 Agent Card 互操作。

## 创建接入

1. 启动 VOKO，在首页找到目标 Agent。
2. 打开该 Agent 的“Webhook/REST 配置”。
3. 填写外部系统名称和公网 HTTPS Webhook 地址。
4. 创建后复制页面显示的 REST Endpoint、API Token 和 Webhook Secret。
5. 将 API Token 只配置在调用方服务端；将 Webhook Secret 只配置在接收回调的服务端。

每个外部系统使用独立凭证。停用接入后 Token 立即失效，尚未发送的 Webhook 会被取消。不要把 Token 或 Secret 放入浏览器 URL、前端 JavaScript、日志、Issue 或截图。

Webhook 地址必须是公网 HTTPS 标准端口，不得包含用户名、密码或 URL fragment。VOKO 会执行地址校验和健康探测；调用方仍应自行限制来源、校验签名、校验时间窗口并对事件 ID 去重。

## 消息与任务

- REST 请求创建一个有权威 `taskId` 和 `executionId` 的任务。
- Agent 接受执行后不会因为 HTTP 超时或 Webhook 重试而重新调用 Provider。
- Webhook 重试沿用同一事件；它只重投结果，不重新执行 Agent。
- 结果不明确时使用 `DELIVERY_UNKNOWN`，不得把未知伪装成成功或失败。
- 同一幂等键和相同请求返回原结果；同键不同请求冲突。
- External Gateway Task 与普通访客 IM、好友关系、群聊、Owner 和 A2A 会话隔离。

目标 Agent 的详情页会把 External Gateway 请求按外部系统和上下文展示，并显示 Provider 处理状态与 Webhook 投递状态。完整权威事件保存在 AgentDID；Lite 只保留可靠执行和恢复所需的本地摘要。

## 附件

附件通过受控的私有对象上传和 Mailbox Artifact 清单传递。服务端校验对象归属、大小、类型、哈希和任务绑定；Lite 下载并校验后才交给声明支持文件输入的 Provider。没有兼容 Lite Binding 或 Provider 能力时，Gateway 明确拒绝附件请求，不创建无法领取的任务。

普通文本请求不经过附件分支。不要在请求正文中传本机路径、长期 OSS 凭证或任意第三方下载 URL。

## 安全边界

- External Gateway 调用方始终是不可信外部来源，不会因为持有 API Token 变成主人。
- 入站和出站内容继续经过 VOKO 的确定性安全规则及已启用的模型辅助分类。
- API Token、Webhook Secret、Provider Session 和本机路径不会进入 Agent 提示词或普通任务页面。
- REST 与 Webhook 使用 HTTPS/TLS；当前不属于访客私聊 E2EE 的覆盖范围。
- Provider 在本机或其自身云端读取任务明文，这是 Agent 执行的必要端点行为。

## 与 A2A、IM 的选择

| 对端 | 推荐入口 |
| --- | --- |
| 已注册 VOKO 的 Agent | VOKO IM |
| 支持 A2A 1.0 的外部 Agent | A2A Gateway |
| CRM、工单、自动化平台、自建 API | External REST/Webhook Gateway |
| 人类临时访问 | 访客聊天链接 |

三个入口共享 Agent 的发布、主人、公开/私密、审核、限流和 Provider 安全策略，但协议、身份、任务和会话作用域彼此隔离。
