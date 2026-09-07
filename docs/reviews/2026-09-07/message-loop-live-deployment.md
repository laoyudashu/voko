# 消息闭环修复部署结果（2026-09-07）

AgentDID 和 macOS、Ubuntu、Windows Lite 已部署。部署时尚未提交代码，未 push 或发布 npm；版本号仍为 0.5.3，使用此前已验证的修复包。

## 部署与验证

- AgentDID 仅替换 `services/e2eeDeviceDirectoryService.js`；上线前文件哈希与本地 HEAD 完全一致。已备份，重启后 active，公开健康接口正常，最近服务错误日志无记录。
- 服务端备份：`/opt/agentdid-backups/message-loop-20260907-210345`。
- 三端使用同一安装包，SHA256：`825f4f8a59458677dcc96e30899e4064a595259d1cb7dff0e92735aa74024e15`。
- 运行中与安装目录 build digest 均为 `ef3838d5fe8628feae483f0cfc3612822eeb1d5daac4c95de43e97e267722141`。
- 三端均 ready，IM 连接分别为 macOS 18/18、Ubuntu 12/12、Windows 21/21；这不表示所有 Provider 都可自动执行。
- 安装后原生策略回归各 53/53 通过，数据库安全配置摘要与部署前一致。macOS 首轮 52/53：测试读取正在写入的 JSON 日志出现 Unexpected end of JSON input；未改代码重跑后 53/53。保留这一不稳定性说明。
- 部署前修复定向测试三端各 99/99；AgentDID 全量 353 通过、1 跳过。Lite 全量原有 3 个基线失败仍未解决。

## 真实消息验证

每次使用新的唯一标记，使用 E2EE，未重放旧失败消息。

| 链路 | 入口 | 结果 |
|---|---|---|
| Linux Hermes Human → macOS ZeroClaw | MCP | COMPLETED / DELIVERED |
| macOS ZeroClaw → Windows ZeroClaw | MCP | COMPLETED / DELIVERED |
| Windows ZeroClaw Human → Linux Hermes | CLI | COMPLETED / DELIVERED |
| macOS ZeroClaw → Linux ZeroClaw | CLI | 未通过：历史会话锁 |

通过项均核对接收侧标记消息、回复记录和 ProviderTurn。验证使用真实 CLI/MCP 与运行中的 Provider，未执行浏览器端回归，也未覆盖所有 Provider。

## 未通过项与后续范围

Linux ZeroClaw 对应协议会话仍处于部署前的 `locked / PEER_NOT_FOUND / dormant` 状态。此次消息接收回执明确为 `failed / E2EE_V2_CONVERSATION_LOCKED`；未投射到业务消息、未进入 Agent。发送端只见传输已发送，等待执行回执最终超时。

这说明服务端准入修复不会自动解除历史持久化会话锁；接收侧加密失败的终态回传也仍有缺口。本轮保留原状态，未清库、强行解锁、降级明文或重试未知结果。后续应设计先重新验证目录准入及身份一致性、再限定恢复旧拒绝锁的流程，并补接收侧失败回执。

完整机器记录与各端备份路径见工作区 `artifacts/message-loop-live-20260907/deployment.json`，原始测试、消息、日志和精确锁状态证据同目录保存。
