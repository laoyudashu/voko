# 三端日志及网页复核：2026-09-05 13:40 UTC 附近

## 当前结论

同一 e58a0d2 候选仍在三端运行，构建摘要均为 `14b0f0340628718fc02d1da2ded402a229217e2e27bb753191a10e5278d4e732`。本次状态采样 Mac PID 51666、Linux PID 243244、Windows PID 11836 均 READY，IM 分别 17/17、12/12、21/21；未发现进程更换或构建漂移。检查窗口从各进程本次启动开始（约 12:59–13:01 UTC），业务日志读至约 13:38 UTC，另读取告警时间线和 Windows 原生程序诊断。

当前候选已向全部 50 个 Agent 的真实 IM 身份发送新标记消息，并通过 macOS Chrome 逐项复核：45 个显示正确答案，5 个尚未回复。Mac 16/17，Linux 12/12，Windows 17/21。此数字只表示正确答案在网页可见，不代表严格一句话格式、所有工具能力或长期稳定性全部通过。

## 新增确认：Windows DuMate 原生启动崩溃

既有 `verify_delivery_channel` 的隔离回环检测报告 `DuMate serve exited with code 3221225477`，没有 stderr。随后绕过 VOKO 业务调用，直接执行已安装的 `C:\Program Files\DuMate\resources\extra-resource\opencode\bin\dumate-opencode.exe --version`，同样退出 3221225477，stdout/stderr 均为 0 字节。这将当前失败定位到 DuMate 原生程序启动阶段，不能用调整 VOKO 的消息路由或超时解释为已修复。

当前 Node 架构 arm64，DuMate PE machine 8664（x64）；该差异是待验证的兼容性线索，不足以确认崩溃唯一根因。最近两小时 Application / Event ID 1000 按 DuMate、qoderclicn 筛选未返回匹配记录，因此尚无故障模块或调用栈。未删除登录数据、替换 Provider 或降低权限。建议下一步取得适配当前系统的原生构建，或在兼容主机对同一程序做对照，并保留原生退出码；不能将其计为 VOKO 最新包导致的崩溃。

原始脱敏证据：`artifacts/production-remediation-acp-20260905/windows-dumate-native-version.json`、`windows-native-crash-events.json`。回环失败来自工具返回，未声称在 voko-im.log 中记录了完整崩溃堆栈。

## 已恢复，但保留历史失败

- Mac DuMate、千问办公 o9hPdJ 原配置均仅 Pull；完成各自实际回环 challenge 验证后，用现有 update_agent_profile 分别保存 HTTP/Pull、CLI/Pull。新的 R2 消息均在网页显示正确答案，日志分别 generated/delivered。没有修改身份、可见性或安全策略。投递模式已持久保存，但回环验证属于运行时状态，未声称重启后仍保持验证结果。
- Windows CodeBuddy R1 的 ACP initialize 15 秒超时仍是真实失败；最新候选将提交前失败正确记为 not_delivered。之后新建的 R2 普通算术消息成功，网页和日志均确认。没有重放 outcome_unknown 请求，也没有延长生产超时。根因尚未证实，单次恢复不能证明间歇性启动问题已根治。
- Windows OpenCode、Cline 本轮通过既有 opencode-attach、cline-cli 后备路径取得正确回复；ACP 初始化超时本身并未被声称完全消失。
- Mac/Linux Copilot 和 Windows WorkBuddy 在本候选均实际回复成功。旧候选拒答或服务不可用仍保留为历史记录，不能继续当作本轮失败，也没有证据证明其长期稳定性已恢复。

## 仍未通过的 5 个 Agent

| Agent | 当前证据 | 后续处理 |
| --- | --- | --- |
| AUTO-REG-MAC-20260828 | backend=others，网页自动回复未启用 | 明确真实 Provider 后按其能力绑定；不猜测或替换身份 |
| AUTO-REG-WINDOWS-20260828 | backend=others，网页自动回复未启用 | 同上 |
| TEST-WINDOWS-OPENHANDS | Catalog 的 transports 为空且默认 Pull；当前文档明确如此 | 自动 Push 需要独立完成通道迁移、安全约束与真机门禁；不能仅改 deliveryModes |
| TEST-WINDOWS-QWEN-OFFICE | status 原生退出 3221225477，或 readiness 超时；网页未自动回复 | 继续原生兼容性排查；增加超时不能当作修复 |
| TEST-WINDOWS-DUMATE | serve 和直接 --version 均原生崩溃；网页未自动回复 | 原生构建/兼容环境对照，见上文 |

OpenHands 是既有能力边界，尚未确认是本轮回归。仓库 `docs/providers/openhands.md` 的历史 ACP/CLI 验证不能代替当前 Catalog 注册。旧 CLI 适配器安全 hook 还存在异常被忽略的路径，不能为了测试成功直接开放 headless Push；本轮没有修改 Catalog 或放宽权限。

## 仍出现的日志及较小问题

- Linux 出现目录超时、A2A 注册请求失败和一次邮件 API 告警；Windows 出现目录超时与历史 PEER_NOT_FOUND。最后一次本窗口目录超时在 13:22:49 UTC（Windows）；没有据此修改私有 Agent 可见性或绕过加密。
- Windows 启动期 Hermes models 401 仍存在，但当前 Hermes 网页消息成功。先前实际 profile 的 health/models 对照为 200，启动候选探针失败不等于当前整个 Provider 认证失败。
- ACP 多条“发送 session/prompt”正常进度通过 console.error 输出，被宿主日志标成 ERR；随后对应 ProviderTurn generated/delivered。这是已确认的日志等级问题，应该使用不污染协议 stdout 的结构化日志等级通道，不能简单改 stdout 破坏 MCP stdio。
- Windows Aider 的正确答案后多出 `session.`；Linux Copilot 正确答案后有较长解释。两者按答案正确计数，但不满足严格的一句回复格式；额外文本来源尚未确认。
- Linux ZeroClaw 的网页仍显示旧 AUTO-REG-LINUX-20260828 名称。已经用当前 list_agents 的 IM UID 对上相同身份，未用其他 Agent 替代。需要另查名称同步路径。
- 一些会话切换后暂时显示处理中，后台历史同步后出现答案。未取得永久消息丢失证据，也不能将首次 DOM 快照当作最终结果。

本窗口没有确认最新候选引入新的安全边界回归，但此次检查不是完整安全证明。目标仍 active，全部 50 个 Agent 均保留；45 个正确可见回复不能宣称全部优化完成。
