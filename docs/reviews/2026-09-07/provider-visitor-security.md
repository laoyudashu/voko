# Provider 访客消息转发安全评估

日期：2026-09-07。基线：`870a0b3e6f3888b5ba2235796986fef9c528d538`，另含本次未提交修复。

设计更新：独立 Agent 审查后，开发安排以 [开发计划 v2](provider-visitor-development-plan-v2.md) 为准；[审查与采纳记录](independent-admission-design-review.md)说明哪些设计被保留、简化或延期。以下漏洞证据仍有效，不代表 P0 已修复。

## 结论

**尚不健全。** 系统已有访客来源标记、部分 Provider 原生工具限制、策略租约、会话绑定和结果未知时禁止重投等基础，但“访客可以访问 Agent”与“Agent 可以读取哪些消息、调用哪些工具”之间还没有完整的强制边界。

主要问题是：入站准入结果没有被所有后续路径共同执行；不同 transport 的宿主机能力约束也不等价。增加安全提示语不能修复这两个问题。

本轮以当前源码、内存数据库复现、模拟协议/进程回归为证据。没有连接真实访客、调用付费模型、启动真实 Provider、操作生产数据库或部署服务。没有验证当前各机器安装版本的文件、Shell、网络隔离，不能据此宣布某个 Provider 已通过真机安全认证。

## 已证实的问题

### P1：被拒绝消息可经 Pull 或历史恢复重新进入 Agent 输入

入口先把原文存入 `messages`，然后执行发布状态与黑白名单检查。`markIntercepted()` 只设置内存消息属性、处理队列和回执，没有持久化可供后续读取强制检查的准入结果。

- 黑名单、私有模式非白名单、未发布三种拒绝：即时转发被阻止，但原文仍是普通 `content_type=1/status=received` 消息。
- 通用会话恢复按 Agent、私聊频道读取历史，不检查准入结果。CLI 另有一套独立历史查询，同样没有准入检查。
- 非会话限定的 `fetch_new_messages` 返回这些消息。入站 `hard_deny` 虽被转换成 `content_type=11` 审核记录、被恢复上下文排除，Pull 仍返回包含原文的审核 JSON。
- Pull 返回“不可信”标签不等于拒绝执行。调用方仍获得了本应被准入门禁阻止的原文。本轮证明的是原文重新暴露，没有声称模型已执行攻击。

证据：[消息保存与准入检查](../../../src/core/messenger.ts:708)、[内存拦截标记](../../../src/core/messenger.ts:611)、[历史恢复查询](../../../src/core/dispatcher/conversation-context.ts:44)、[CLI 历史查询](../../../src/core/adapters/cli-adapter.ts:289)、[Pull 查询](../../../src/mcp/tools.ts:3458)、[Pull 的 A2A 包装](../../../src/core/dispatcher/index.ts:2091)。会话限定 Pull 的额外路由过滤不能替代普通路径缺失的准入检查。

### P1：群聊可绕过单聊的黑名单和发布状态限制

群聊在进入单聊准入检查前分流；`_handleGroupMessage()` 检查 @、系统消息和入站审核，但没有检查 Agent 黑名单或发布状态。

本轮复现：黑名单访客 @ Agent，以及未发布 Agent 收到 @，均返回可转发 payload，群消息也可被 Pull 获取。复现使用 `skipForward=true`，证明接收入口放行，不实际调用 Provider。

白名单是否仅用于私聊，是产品语义选择；不能直接断言“所有群成员必须加入私聊白名单”。但黑名单和下架状态在群聊失效，应明确修正或明确限定其作用域。

证据：[提前分流](../../../src/core/messenger.ts:640)、[群聊入口](../../../src/core/messenger.ts:906)、[群聊放行](../../../src/core/messenger.ts:1000)。

### P1：准入撤销没有覆盖待提交队列

消息通过入站检查进入合并队列后，执行 `_dispatchInboundTurn()` 时不会重新检查黑名单、发布状态或准入版本。内存复现中先接收正常消息，再拉黑访客、刷新队列，dispatcher 仍收到一次调用。

这不意味着可以撤回已经提交给 Provider 的请求；缺口发生在尚可阻止提交的阶段。后续 Provider 内部还可能排队，应在最终提交边界复核，而不只在消息入队时检查。

证据：[合并队列提交](../../../src/core/messenger.ts:241)、[现有最终提交检查](../../../src/core/dispatcher/index.ts:1754)。后者主要检查生命周期与隔离任务过期，不是统一访客准入复核。

### P2：安全能力被误报为 Provider 强制执行——本轮已修复

`inspect().assurance` 原先以“有可编辑项”为依据返回 `provider_enforced`。这使仅有安全提示语的 OpenCode 未验证通道、以及仅有 VOKO 会话控制的 DuMate 都可能被误报。

已改为只在展示的可编辑项确实属于 `provider_enforced` 时返回该值，否则保留 `fixed_or_unverified`。该字段仍只描述存在相应原生控制，不代表完整文件/网络/工具隔离。

同时删除统一提示语中“实际权限由 Provider 参数强制”的无条件承诺，明确提示语本身不证明强制边界成立。已补未知能力、VOKO 自身控制及原生控制正例的回归断言。

证据：[修复判断](../../../src/core/provider-security-policy.ts:678)、[统一提示语](../../../src/core/provider-security-policy.ts:1238)、[回归测试](../../../test/provider-security-policy.test.js)。

## Provider / transport 控制差异

下表是当前适配代码的控制面评估，均不能覆盖前述消息准入缺口。“原生限制”指适配器确有参数或配置，不等于本轮已证明当前真实二进制遵守限制。

| Provider / transport | 当前可见控制 | 边界与待验证事项 |
|---|---|---|
| Claude CLI | plan、默认禁用工具、关闭浏览器；策略可开放只读工具 | 开放 Read 后的读取范围需独立约束；不是宿主机隔离 |
| Codex CLI | read-only、never approval，执行前检查沙箱 canary 证据 | 本地 canary 门禁是较强基础；只读不等于私密文件不可读；workspace-write 扩权应按实际证据评估 |
| Qwen Code CLI、Pi CLI、Grok CLI | 排除危险工具、无工具或显式拒绝工具规则 | 需要逐版本验证默认工具、扩展和用户配置是否仍能引入能力 |
| GitHub Copilot CLI / ACP | 显式拒绝 read/write/shell/url，限制 MCP/remote；ACP 另拒绝权限请求 | 原生工具规则是主要边界，不能用空工具字符串推断拒绝全部 |
| OpenCode CLI / ACP / attach | deny 配置、项目配置隔离；CLI 有 pure/auto 策略；attach 使用回环与密码 | 三种 transport 必须分别验证；auto 扩权与用户插件不能按其他通道证据推断 |
| WorkBuddy HTTP | 默认无工具、dontAsk、strict MCP；可配置只读数据访问 | `Read(path)` 不是路径隔离；后续命令检查还发现无工具模式同时传指定专家与 voko 两个 --agent，指定专家生效需另验 |
| 千问办公 CLI | 默认无工具、dont_ask、空 MCP 配置；可开放工具/绕过审批 | 扩权经主人确认但仍会作用于访客轮次；需验证组合设置下真实边界 |
| CodeBuddy ACP、Trae ACP | 无工具/计划模式或禁用危险工具，ACP 拒绝权限请求 | 不能等同于进程无文件读取、无网络、无插件能力 |
| Hermes CLI | 默认 safe toolsets、safe-mode；可控制 hooks/yolo | safe 工具集不是无工具；profile 与 transport 策略需要一致 |
| Hermes HTTP | 复用 Provider 服务与会话；有统一来源提示和租约 | 本路径没有 CLI 的逐轮 safe 参数，不应继承 CLI 的安全结论 |
| OpenClaw CLI / WS | Agent/会话路由及来源提示，使用 Provider 配置/运行时 | 没有统一 VOKO 工具代理；宿主机权限取决于 OpenClaw 原生配置 |
| ZeroClaw CLI / ACP / WS | 原生 Agent risk profile、工作区/审批等配置；ACP 拒绝权限请求 | 配置级边界须结合 nativePolicyState、重启时机及真实版本验证 |
| Gemini CLI | 要求 Docker 可用并设置 GEMINI_SANDBOX=docker | 默认非 enforce rollout 使用 yolo；网络在模型中为 unrestricted。容器存在不能证明挂载、环境与网络满足访客安全要求 |
| Cursor CLI / ACP、Goose CLI / ACP | CLI 有规划/扩展限制；通用 ACP 默认拒绝 requestPermission | ACP 只能拒绝经过客户端申请的能力；不能保证 Provider 内置工具全部经过此回调 |
| Cline CLI / ACP | CLI 命令策略；ACP 拒绝权限请求；共享 Hub 串行控制 | 串行是并发正确性控制，不是权限隔离 |
| Aider CLI、Reasonix CLI、Kiro CLI | ask/dry-run/no-git、dontAsk、非交互无信任类别等不同约束 | 只读、Provider Web、已加载 Agent 配置等边界不同，不能统一声称无工具/无网络 |
| OpenHands | 当前 Catalog 只启用 Pull，仓库仍保留 CLI / ACP 适配文件 | 不以未启用文件的 Python hook / ACP 参数认定当前已有 Push 防护 |
| DuMate HTTP | 独立数据根目录、回环监听、会话复用策略 | 无原生工具权限参数。现有元数据已标注文件写入/Shell/网络风险；本轮未复测，不能视为安全访客执行环境 |
| DeepSeek Harness CLI / HTTP | HTTP 按绑定 preset 建立会话；CLI 使用启动 profile，默认 headless | 未找到统一工具限制；CLI 没有把每 Agent 的 backend_instance_id 映射为本轮 preset，目标绑定与权限需分别验证 |
| Pull / 自定义外部通道 | 结构化不可信上下文，调用者/会话路由约束视配置而定 | Pull 不租用 Push 的 Provider 权限策略；接收端执行工具不受 Push 参数控制 |

参考：[策略定义](../../../src/core/provider-security-policy.ts)、[通用 ACP 拒绝权限](../../../src/core/adapters/acp-adapter.ts:927)、[DuMate 风险披露](../../../src/core/provider-security-policy.ts:223)、[Gemini 默认策略](../../../src/core/dispatcher/providers/gemini-cli.ts:41)、[Codex 执行门禁](../../../src/core/dispatcher/providers/codex-cli.ts:100)。

Owner Chat / Owner Link 是单独授权域；例如 Codex app-server 为 Owner-only，不应混入访客能力矩阵。A2A 正文同样不可信，但当前策略租约显式排除 agent_peer，不能借转发自动获得 Owner 权限；本轮未证明存在由访客伪造 Owner 身份的可达漏洞。

## 跨 Provider 的剩余风险

- **缺少统一工具授权边界**：Provider 内置工具、用户 MCP、hooks、既有配置可拥有不同宿主权限。ACP 拒绝审批只约束请求回调；原生允许的工具可能不回调。确定风险需分别用无副作用 canary 验证。
- **环境与文件读取**：通用 CLI 子进程默认合并 `process.env`；临时 cwd 不等于隔离 HOME/凭据/网络。不能在没有认证依赖清单的情况下直接清空环境，否则会破坏 Provider 登录。见 [childEnv](../../../src/core/adapters/cli-spawner.ts:117)。
- **输出侧控制有限**：显式推理块过滤、出站消息审核、附件安全检查已有实现；它们不构成“私人文件/主人数据绝不返回访客”的信息流授权机制。本轮未验证实际秘密泄露。
- **备用通道安全级别不等价**：当前只对明确 not_delivered 回退，避免未知结果重复执行；但目标通道可仅有提示语级控制。是否允许这样的自动接待，需要策略明确；不能只根据可用性定义“安全 Push”。

## 刷新后的修复方案

独立审查结论为“方向正确，局部过度设计”。以 [开发计划 v2](provider-visitor-development-plan-v2.md) 替代原提纲：

1. 保留每 Agent 的小型 pending/allowed/denied 准入记录；删除新增策略版本体系和持久化 @ 资格。
2. 保留统一读取、群黑名单/下架检查；补齐首次群资格检查、Pull-only 异步审核及群审核不得改写共享原文。
3. 最终提交时读当前权限；同时处理提前拼好的群历史，不能仅检查最后一条发送者。
4. 单独修复已复现的多频道 Pull 分页漏读；不引入新队列或游标协议。
5. MANUAL/计费等自动暂停与永久内容拒绝分开。未知旧历史先分类统计，再决定严格或兼容迁移，不把未知直接称为已拒绝。
6. 原生专家绑定、Provider 权限真机验证、备用通道权限约束作为后续 P1，不混入两项 P0。

本轮只刷新计划，P0 功能仍未实施。用户请求审查和刷新计划不等于批准高影响实现或生产迁移。

## 本轮验证与交付状态

- 已修：`assurance` 误报与提示语过度承诺；没有提交、推送或部署。
- 构建 `npm run build:ts`、类型检查 `npm run typecheck`、`git diff --check` 通过。
- 10 个相关测试文件共 **110 项通过，0 失败、0 跳过**：provider-security-policy、provider-capability、web-provider-security、provider-sandbox、acp-delivery-boundary、lite-conversation-recovery、lite-messenger-contract、access-control-boundaries、provider-cli-execution-evidence、provider-attachments。
- [可复现脚本](provider-visitor-security-reproduce.cjs)覆盖 7 个场景，使用真实接收/恢复/Pull 逻辑与内存 SQLite，依赖接口为本地替身。脚本是漏洞观察工具，输出漏洞存在状态，不把已知不安全行为写成期望通过的产品回归。

| 复现场景 | 即时入口结果 | 历史恢复含被拒原文 | Pull 含被拒原文 |
|---|---|---|---|
| 黑名单 | 拒绝 | 是 | 是 |
| 私聊非白名单 | 拒绝 | 是 | 是 |
| 未发布 | 拒绝 | 是 | 是 |
| 入站 hard_deny | 拒绝 | 否 | 是，审核 JSON 中原文 |
| 群聊黑名单 @ | 返回转发 payload | 不适用 | 是 |
| 群聊未发布 @ | 返回转发 payload | 不适用 | 是 |
| 入队后拉黑 | 刷新队列后仍调用 dispatcher 一次 | 是 | 是 |

复现命令：`node docs/reviews/2026-09-07/provider-visitor-security-reproduce.cjs`。正常安全测试通过不能覆盖这些跨入口反例，因此本次不能给出“全部补齐/安全通过”的结论。
