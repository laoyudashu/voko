# WorkBuddy

WorkBuddy 与 VOKO 有两个不同方向：

- **WorkBuddy → VOKO**：WorkBuddy 作为 MCP 客户端调用 `voko mcp`。
- **VOKO → WorkBuddy**：VOKO 使用 WorkBuddy 桌面版内置 CodeBuddy HTTP API 自动投递新消息。

## 自动投递顺序

```text
WorkBuddy HTTP → Pull
```

VOKO 自动寻找桌面版内置 CLI，不要求把 `codebuddy` 加入系统 `PATH`。VOKO 启动的服务只监听 `127.0.0.1`，使用动态端口；停止 Lite 时只关闭自己启动的服务，不关闭 WorkBuddy 桌面应用。

HTTP 请求一旦获得 `runId` 就视为 WorkBuddy 已接受。此后若 SSE 中断，VOKO只恢复同一个 Run；无法确认结果时标记为结果未知，不重新提交任务。Pull 始终保留。

## 会话与安全

- 每个 VOKO Agent、访客、群聊、Owner 和 A2A Context 使用不同的不透明会话作用域。
- WorkBuddy 返回的原生 Session ID 只保存在本机 Provider 会话绑定中，不写入日志或远程服务。
- 外部访客消息仍先经过 VOKO 现有审核与安全上下文。
- WorkBuddy 的文件、网络、命令和人工审批能力由 Provider 管理；VOKO 不把本机 HTTP 可用误报为已启用沙箱。
- `X-CodeBuddy-Request: 1` 是协议头，不是网络认证，因此 VOKO 不允许服务监听局域网或公网地址。

## 兼容性基线

Windows 真机已验证 WorkBuddy Desktop 5.3.11、内置 CodeBuddy CLI 2.115.0 的健康检查、任务提交、SSE 回复、状态查询、取消和 Session 接口。HTTP API 仍为 Beta，VOKO 每次启动都会检查实际 OpenAPI 是否包含必需路由；不满足时自动保留 Pull。
