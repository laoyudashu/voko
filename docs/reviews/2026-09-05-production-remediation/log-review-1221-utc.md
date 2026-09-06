# 2026-09-05 12:21 UTC 日志复核

范围：三端当前部署候选 0f4ada3；读取 voko-im.log、events.jsonl 和 status。统计窗口为各主机采样前 60 分钟，约 11:21–12:21 UTC。Mac/Windows 日志使用 America/Los_Angeles，Linux 使用 Asia/Shanghai，已按各端时区转换。不是全天统计，也不是全 Agent 对话验收。

| 主机 | 状态 / IM | 最近一小时错误与告警 |
| --- | --- | --- |
| macOS | READY / 17/17 | 0 |
| Linux | READY / 12/12 | 3 次目录公钥同步 10 秒超时；1 次 A2A outbound-results fetch failed，6 秒后有恢复记录 |
| Windows | READY / 21/21 | 千问办公 10 条告警；历史加密锁恢复 PEER_NOT_FOUND 7 条 |

三端 PID 仍分别为 88753、232247、7744，运行摘要一致。当前窗口未发现新崩溃或实例替换证据。events.jsonl 本窗口无 warn/error 事件。50 个 IM 连接正常不等于 Provider 全部可用：当前自动交付未就绪共 11 个，Mac 5、Windows 6，与第三批部署前记录对比无变化。

## 结论和处理建议

1. Windows 千问办公是持续的已知问题，原生 status 仍可能 exitCode=3221225477，也出现 status_timeout/10000ms。日志不足以进一步确定原生崩溃根因；应继续原生兼容性/厂商诊断，不延长超时来掩盖失败。
2. Linux 间歇性网络失败此前已有。A2A 当前样本恢复耗时 6 秒；目录超时日志为 attempt=1/2、retrying=true，不能仅据此断言第二次重试成功。若持续发生，需结合请求时延与服务端同时间窗口核对，而不是直接归因于新包。
3. Windows 新写入的 7 条历史锁日志仍是已有 PEER_NOT_FOUND 类别。样本 recovered=0、dormant=1；当前代码在稳定目录业务拒绝累计 8 次后停止自动重试并保留加密锁。该日志说明恢复仍失败，不代表新锁刚产生，也不能据此确认与先前某一具体 peer 完全相同。不得通过明文回退、取消加密锁或擅自开放私有 Agent 消除告警。
4. 本轮实际对话另外确认一处日志等级噪声：Linux OpenCode 在 12:21:51 UTC 记录 ERR“发送 session/prompt...”，但 12:22:05 UTC 对应 ProviderTurn 为 generated/delivered，网页也显示正确回复。源代码 acp-adapter.ts:617 使用 console.error 输出正常进度，index.ts:265 将其持久化为 ERR。这是已存在的日志分类问题，不是调用失败。后续整理应保留 CLI/MCP 标准输出边界，使正常诊断与真正错误的日志级别分离；本次只记录，未修改运行代码。

当前证据未确认这轮候选包引入新的功能或安全回归；这不代表全部问题已解决。Windows Hermes 的 401 仅见于本次启动阶段，不能据此把当前整个 Provider 判为认证失败。

## 网页恢复后的补充验证

网页重新可输入，未清理 Cookie、本地密钥或降低加密。此前连接提示的根因仍未确定；只读浏览器错误/告警日志为空，已保留的网络事件批次没有 HTTP >=400 或 loadingFailed，不能把这些空结果当作从未发生异常的证明。

12:21–12:22 UTC 经 macOS Chrome 向 Linux Qwen、Goose、OpenCode 各发送一条“7加8等于多少？”的新候选回归消息，三者网页均显示正确答案 15。对应 ProviderTurn 均 generated/delivered，耗时分别 14223、7260、20889ms。当前候选已核实 3/50 个 Agent 的网页回复，其余 47 个仍待验收。完整目标保持 active。

脱敏原始摘要：artifacts/production-remediation-policy-20260905/*-last-hour-log-evidence.json、linux-browser-resumed-log-evidence.json。此目录按既有规则忽略；可提交结论及逐项状态保存在本审查目录。
