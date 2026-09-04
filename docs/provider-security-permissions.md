# Provider 动态能力与权限管理

VOKO 的权限页面不使用一套适用于所有智能体框架的固定开关。页面和实际转发共同依据当前 Agent、实际通信模式、操作系统、架构、框架/运行时版本、可执行文件 fingerprint 与能力证据决定可配置项。

## 权限作用域

权限由两层配置合并：

- **Agent 公共权限**：属于同一个 Provider 实例或 profile 的持久策略，例如 ZeroClaw risk profile、Hermes profile 证据或 OpenCode 项目/配置身份。
- **通信模式权限**：只影响当前 CLI、ACP、HTTP、WebSocket 或 attach transport 的调用参数和安全提示语。

存储作用域不等于生效范围。一个 Agent 级设置可能要求 ACP 进程重启或 Gateway reload；一个 CLI 参数通常只在下一轮进程生效。切换权限页中的 transport 只切换查看和编辑对象，不会修改消息投递顺序。

## 能力证据与刷新

VOKO 启动后异步探测已配置的自动通道。权限页显示缓存结果并在证据过期、运行时变化或用户选择“重新检测”时刷新。消息转发前只做快速 fingerprint 校验；缺少当前证据时等待有上限的共享探测，不会无限阻塞。

能力快照至少区分 Provider family、transport、平台、架构、框架/运行时版本、fingerprint、适配器修订和逐项控制证据。`--help` 或参数存在只说明语法可用，不等于权限边界已经成立；未经当前版本验证的控制项不会渲染为可编辑开关。

状态含义：

- **已验证**：当前 fingerprint 和逐项能力证据一致。
- **兼容或上次已验证**：fingerprint 未变化，可按后端规则使用最近证据。
- **运行时已变化**：旧参数不能直接继承，需重新检测。
- **未知或失败**：不猜测 Provider 参数，只保留安全提示语、固定边界或 Pull。

## 保存与本轮执行

权限保存使用预检和提交两步，并绑定页面所见的策略 revision、capability digest、runtime fingerprint 和 Provider 原生策略摘要。保存期间环境发生变化时会拒绝提交，要求刷新后重新确认。高风险扩权需要输入完整 Agent 名称；降低权限不要求该确认。

每一轮消息都会租用一份不可变的 Agent 策略、transport 策略和能力快照。安全参数预览与实际 CLI argv、HTTP、ACP 或 WebSocket 调用使用同一个 planner，避免页面显示与真实转发不一致。旧会话不会被分成“新权限会话”和“旧权限会话”；下一轮根据最新有效策略重新生成调用，但需要重启 Provider 或重建原生 session 的设置会明确标注生效时机。

## 超时与安全降级

探测采用 single-flight、总超时和短期熔断。无法及时取得新证据时：

1. fingerprint 未变化且存在最近验证结果，可按规则使用 `stale_verified`；
2. 只有明确 `not_delivered` 才能选择已配置且会话兼容的备选 transport；
3. 请求已经提交或结果未知时禁止重投；
4. 没有安全 Push 路径时，普通访客消息保留等待 Agent Pull；精确绑定、A2A、Owner 或 E2EE 路径不为通过测试而跨 transport。

“消息已安全保存，等待 Agent 拉取”不等于“已投递”。详细路由和结果语义以 [Provider Transport 行为矩阵](provider-transport-matrix.md)为准。

## 当前重点适配

- **ZeroClaw**：Agent 级 risk profile 与 CLI、ACP、ACP WebSocket 分开；共享 `default` 不由 VOKO 修改。
- **Hermes**：profile 级证据可与 CLI/HTTP 的独立调用策略共存；CLI 高风险参数由用户确认后决定。
- **OpenCode**：CLI、ACP、attach 分别维护能力、状态和策略；某一 transport 未验证不会阻断其他已验证通道。
- **WorkBuddy、千问办公、百度搭子**：按当前运行时和实际 transport 显示已经验证的会话、审批、工具、MCP 或宿主机访问控制；参数存在不被描述为路径隔离或操作系统沙箱。

其他 Provider 在没有逐项真机证据时只显示安全提示语和固定边界。新增验证规则后，权限项由 capability snapshot 自动出现，不需要在页面维护 Provider 名单。

## 验证与隐私

真机验证按实际 transport、版本、文档/社区信息、实际调用边界和无副作用 canary 执行，并覆盖 macOS、Windows 和 Ubuntu Linux 的已就绪环境。探测及审计不保存密钥、完整原生配置、完整路径、完整 argv 或访客原文。

Provider 参数只是纵深防御的一部分。模型安全提示语不能替代 VOKO 强制边界、Provider 原生隔离或操作系统沙箱。
