# 16:45 UTC 日志复核：2026-09-05

## 范围与当前状态

复核上轮全量网页验收结束后 16:07:10–16:45:06 UTC 的三端当前 `voko-im.log`，并只读检查 WorkBuddy 原生会话历史。Mac PID 22176、Linux PID 252984、Windows PID 11672 仍 READY；IM 分别 17/17、12/12、21/21。三个运行构建摘要仍为 `2d0223c0f3a76e4d4eeeffb4fc077beb9877cb415bc5e3bc8b5227f49ea343c3`（代码候选 9b9baff）。

| 平台 | 增量观察 |
| --- | --- |
| macOS | 37 行，无新增 ERR/WRN，无新 ProviderTurn |
| Linux | 39 行，16:23:52 一次 E2EE_V2_DIRECTORY_TIMEOUT，无新 ProviderTurn |
| Windows | 51 行，千问办公原生崩溃告警 1 次；WorkBuddy 回环投递告警和新会话空回复；1 个新 ProviderTurn |

此窗口未匹配到未捕获异常、内存耗尽、SQLITE_CORRUPT 或 SQLITE_FULL。该结论仅限所检查日志，不能代替完整安全审计或所有 Provider 的系统崩溃记录。网页正确回复仍为 44/50；没有把服务 READY 或回环通过计作业务对话成功。

## 新确认：WorkBuddy 回环测试进入业务投递路径

16:19:35 UTC 的日志明确出现两次 Dispatcher 对 `voko-loopback` 的身份检测兜底，随后 E2EE `resolve_recipients` 返回 PEER_NOT_FOUND，Agent 回复投递失败。同次真实回环在 16:19:36 返回挑战匹配成功。

代码链路可重现该行为：`WorkBuddyHttpProvider.runLoopbackTest` 使用实际 Agent 和虚拟 visitor `voko-loopback` 调用 `push`；`_pushAcpSession` 发出正常 `agent.reply` 事件。回环自己的事件监听器与 Dispatcher 的业务回复监听器同时收到事件；没有回环隔离边界。因此回环答案尝试进入正常 IM 投递，但被收件人解析拒绝。

这是已证实的 VOKO 测试隔离缺陷，而不只是外部服务告警。当前没有向真实用户成功发送测试回复的证据；也不应因验证接口成功而忽略该副作用。建议让回环内部接收答案，不向业务回复和生命周期通道发布测试事件；新增验证失败清理、正常消息并发不受影响、业务回复仍正常投递的回归测试。不得屏蔽 PEER_NOT_FOUND 或放宽 E2EE 收件人校验来消除日志。此次仅记录，尚未实施此修复。

## 新失败表现：WorkBuddy 已创建新会话，但没有回复

16:19:36 原生回环通过后，16:22:40.538 从 macOS 网页发送新 R2 标记消息。16:22:58 后台 turn `e2ee-be534d85-3a82-432c-ada5-78846b333cfb` 返回 WORKBUDDY_NEW_EMPTY_REPLY，durationMs=15015，outcome=outcome_unknown。网页显示“消息结果暂时无法确认”。这次是新会话，不是恢复旧会话失败，也不同于 R1 的启动前 ECONNREFUSED / not_delivered。

16:37:46 只读检查原生 session `voko-c7781273-7eb9-4787-8ef3-3678e5e0e825`：history HTTP 200、requests=[]；replay HTTP 200、8 个事件，其中一个 user_message_chunk 精确包含本次 R2 标记，没有 agent_message_chunk。输出只保存事件类型、文本长度和标记匹配布尔值，不保存私密正文。由此确认请求进入了原生会话，尚未找到原生助手答案；没有证据将此条归因为网页遗漏已有答案。原生未生成答案或中途结束的具体原因仍待定位，不能凭 15 秒耗时直接断言是超时设置。

生产 WorkBuddy 子进程与独立探针使用相同 Node 和同一 codebuddy 脚本路径；这次观察排除了不同可执行路径的解释，未排除负载、环境或原生会话处理差异。未知结果 R2 没有自动重放。

## 持续问题与证据边界

- 千问办公 16:08:28 再次原生退出 3221225477。其[官方 Windows 安装要求](https://qwenwork.cn/docs/install/windows)列出 x86_64 (AMD64)，当前 VM 为 Windows ARM64；不符合公布架构要求是已确认的兼容性条件，但尚不能认定它是每次崩溃的唯一根因。未替换桌面应用或原生二进制。
- Linux 目录查询超时属于此前已知错误的再次出现；该窗口没有对应业务 ProviderTurn 失败，不能据此认定消息丢失。
- 当前未通过的六个身份仍是两个 AUTO-REG、Windows OpenHands、千问办公、DuMate、WorkBuddy。前两者实际 Provider 映射和 OpenHands 模型配置仍待明确。
- 既有诊断文案缺陷仍保留：某些明确 not_delivered 的错误被通用 E2EE 日志称为“结果未知”。实际 turn 分类与日志文案应分别看待。

证据保存在 `artifacts/production-remediation-startup-20260905/` 的三端 `*-recent-logs-1645.json`、`windows-workbuddy-loopback-routing.json`、`windows-workbuddy-empty-session.json` 和相关只读原生诊断，以及 `artifacts/production-remediation-startup-fixes-20260905/` 的当前状态、日志和回环结果。execution.json 保留 R1 全量矩阵并追加 R2 证据。此次没有改动运行时代码，没有重新打包或部署。
