# 消息闭环：展示范围与访问准入、发送失败状态

日期：2026-09-07。涉及两个独立仓库：open_voko（Lite）及 voko-server（AgentDID）。未修改生产访问设置。本轮修复已部署至 AgentDID 和三端 Lite，部署结果见 [线上验证报告](message-loop-live-deployment.md)。

## 行为修复

- AgentDID E2EE 目录：已上架、审核通过且允许目录查询的 Agent，在 visibility_type=0（可搜索、不进黄页）时，不再额外要求跨账号白名单。接收方和发送方密钥查询沿用同一修复。黑名单校验、账户/上架/审核条件保留；隐藏类型 2 的既有目录规则未扩展。
- 目录分发公钥不等于允许进入 Agent：Lite 中真正的 access_mode=private 仍通过访客白名单准入；Push、Pull、历史恢复的准入检查保持有效。
- Lite 即时发送失败：记录终止状态和规范化原因码，查询结果不再继续显示等待执行/回复。保留 securityMode、securityReason、outcomeUnknown，避免在共享发送封装处丢失。
- 不确定投递：记录为 unknown / DELIVERY_UNKNOWN，不冒充确定失败；后续有效接收方完成回执仍可确认结果，不自动重发。
- 重启后：利用数据库消息状态恢复 FAILED/UNKNOWN，避免回到 PENDING；精确原因仍遵循原来的内存查询合同，重启丢失详细原因后返回 MESSAGE_SEND_FAILED 或 MESSAGE_DELIVERY_UNKNOWN，不伪造历史原因。
- 回归脚本：send.success=false 时立即停止；轮询读取 transport 而不是不存在的 delivery 字段，FAILED/UNKNOWN 时停止等待。

## 验证

- Lite 定向 99/99；同一修复测试包在 macOS、Ubuntu、Windows 隔离目录各 99/99。包含真正的 private 白名单模式、黑名单、下架、Push/Pull/历史恢复、加密消息及回执恢复回归。
- AgentDID 目录定向 12/12，覆盖跨账号 visibility=0 双向密钥解析和双向黑名单拒绝；全量 353 通过、1 跳过、0 失败。
- 两种探针失败场景验证通过：即时发送拒绝不轮询，传输失败只查询一次并保留 transport=FAILED。
- Lite 构建、类型检查、i18n 对齐、两仓库密钥扫描及差异检查通过。Lite 全量：1677 项中 1673 通过、3 个既有基线失败、1 跳过；失败仍为交互注册共享状态机、短链接 owner token、Agent 管理表单，未新增失败。

## 线上验证

AgentDID 和三端 Lite 已部署，三端均 ready，各完成一条真实 E2EE 消息闭环并核对 ProviderTurn。另一路发往 Linux ZeroClaw 的测试受部署前的持久化会话锁阻挡，尚未恢复；详情与证据见 [线上验证报告](message-loop-live-deployment.md)。没有通过修改可见性、自动添加服务端白名单或明文降级来绕过失败。

具体测试证据位于 artifacts/message-loop-fix-20260907。探针源文件保存在 message-loop-fix/；其部署目录和连接辅助文件沿用本机已有 artifacts，运行前需替换为实际环境。
