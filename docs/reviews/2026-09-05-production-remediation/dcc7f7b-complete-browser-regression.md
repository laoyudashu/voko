# dcc7f7b 完整网页回归：2026-09-05

## 当前结论

Mac 恢复可操作后，继续使用原 Chrome VOKO 标签页及原访客身份。没有重新构建、部署或重启：Mac PID 46965、Linux PID 257660、Windows PID 12768 仍为 READY；实际运行构建摘要均为 bec1436a5a179580d19348b7955a97e2a3a4b6aa33f9fb95ee01d9d9af302805，IM 为 17/17、12/12、21/21。

上轮 17:01–17:04 UTC 已发送 24 条候选消息；本轮 23:20:49–23:22:29 UTC 补发尚未测试的 26 个身份，全部使用 VOKO_UI_DCC7F7B_R1_ 标记，无 R2 消息及未知结果重放。至 23:29:45 UTC，全部原有 50 个身份完成实际网页复核。

| 平台 | 网页正确回复 | 未通过 |
| --- | ---: | ---: |
| macOS | 16/17 | 1 |
| Linux | 12/12 | 0 |
| Windows | 14/21 | 7 |
| 合计 | 42/50 | 8 |

42 个正确可见回复均有同候选当前启动窗口对应的 generated/delivered 记录。后台记录用于核对，没有代替网页观察。Windows WorkBuddy 当前业务答案在页面可见，实际 turn e2ee-46b2a1ae-71a2-4f40-b090-9af946a5dd6d 为 delivered/generated；本轮回环无误投递证据。这支持回环隔离修复已生效，不足以认定先前原生空回复的间歇性问题已根治。

Windows Cline 的可见正文包含“这段消息用于对话测试，不需要调用任何工具。直接回复即可：7加8等于15。”，答案正确但含多余解释，按正确回答计数并保留格式问题。Windows Aider 正确回复未再出现费用摘要 session.。部分会话首次打开仍显示旧的处理状态，再次进入并完成历史同步后回复出现；不能将首次缓存状态判定为永久消息丢失。

## 当前未通过的八项

| 身份 | 当前证据 | 下一步 |
| --- | --- | --- |
| AUTO-REG-MAC-20260828 | 自动回复未启用，backend=others | 仍待实际 Provider 映射，保留原身份 |
| AUTO-REG-WINDOWS-20260828 | 同上 | 同上 |
| TEST-WINDOWS-OPENHANDS | 自动回复未启用；此前证实缺少本地模型配置、当前 Pull-only | 指定已有模型配置后再验证原生权限与自动通道 |
| TEST-WINDOWS-QWEN-OFFICE | 自动回复未启用；原生 readiness 崩溃持续 | 继续原生兼容性定位，不能以绕过验证启用通道 |
| TEST-WINDOWS-DUMATE | 当前网页无法处理，DUMATE_DELIVERY_FAILED / not_delivered | 继续核对原生启动故障；不以旧版或一次成功替代当前验收 |
| TEST-WINDOWS-CODEBUDDY | ACP 连接 15000ms 超时，not_delivered | 对照生产启动与独立握手的环境、负载和阶段耗时 |
| TEST-WINDOWS-OPENCODE | ACP 15000ms 超时；既有 attach 备选也在提交前 health 超时 | 同上，保留两条失败通道证据 |
| TEST-WINDOWS-HERMES | 请求超时，durationMs=122326，outcome_unknown；网页无法确认 | 只读定位原生 API 会话结果和处理阶段，禁止重放未知请求 |

CodeBuddy/OpenCode 的故障类型此前出现过，本轮再次失败。Cline、Copilot 的 ACP 也超时，但既有 CLI 通道最终给出网页正确答案；不能将业务成功扩大为所有底层通道均正常。

## 后续只读/隔离诊断

没有 session/new 或 session/prompt 的独立 ACP 握手探针依次执行，使用新包 Provider 和实际 Windows 原生组件：CodeBuddy 23:29:40 UTC 成功，8530ms；OpenCode 23:30:23 UTC 成功，5438ms。探针允许 45000ms 以观察真实耗时，但生产 15000ms 设置未改。两者本次耗时均小于生产预算，不能凭本结果武断延长超时或认定生产故障已解决。测试自己的子进程已停止。

23:32:25 UTC，只读检查 Hermes 当前配置：VOKO 数据库实际使用的凭据访问 /health 和 /v1/models 均返回 200；当前主配置中的凭据与数据库一致。其他历史配置文件存在不同凭据，访问模型接口为 401；它们不是当前 VOKO 请求使用的凭据，未进行配置替换。该证据排除“当前配置凭据必然失效”的简单解释，不证明超时消息产生了模型答案。

本轮没有新的代码修复，不为通过测试而重放未知请求、放宽权限、改绑身份或更换模型。目标保持 active，八项仍未通过；已解决的 Mac 锁屏不再作为阻塞理由。

## 证据

artifacts/production-remediation-loopback-20260905/browser-sent-complete.json、browser-matrix.json 保存完整候选标记和逐项时间；三端 *-logs.json 保存当前启动窗口摘要；windows-codebuddy-initialize-diagnostic.json、windows-opencode-initialize-diagnostic.json、windows-hermes-auth.json 保存原生诊断。脱敏具体失败位于 artifacts/production-remediation-startup-20260905/windows-current-windows-failures.json。

execution.json 已将当前矩阵更新为 42/50，旧候选结果及锁屏期间的部分验收保存在历史。运行时代码候选仍为 dcc7f7b。

## 23:37 UTC：Hermes 超时后确实完成了模型回复

只读检查当前 Windows Hermes state.db，并使用本轮唯一网页标记定位原生 user 消息 id=156。紧接着的 assistant 消息 id=157 属于同一原生会话，之间没有另一条 user 消息；文本严格匹配“7加8等于15。”，finish_reason=stop。仅输出标记匹配、长度、时间和答案匹配布尔值，没有导出其他用户正文或模型推理。

时间链：网页于 23:21:26.188 UTC 发送；VOKO 于 23:23:31 报请求超时；原生 user 消息于 23:23:49.988 持久化，assistant 于 23:24:04.172 持久化。正确答案在 VOKO 超时约 33 秒后才保存。因此该条不是“模型没有回答”，而是超时后完成的答案没有通过原请求交付到网页。原生 user 持久化前的等待原因尚未确定，不能直接归因为模型推理慢、全局队列或网络问题。

这条新证据将下一步聚焦到原生 API 的请求等待阶段及严格按请求关联的结果恢复。不得为了交付答案而重发原始模型请求，也不能抓取任意最后一条历史回复。当前网页验收仍未通过；尚未实施结果恢复。证据：artifacts/production-remediation-startup-20260905/windows-hermes-current-session.json、windows-hermes-current-timing.json。
