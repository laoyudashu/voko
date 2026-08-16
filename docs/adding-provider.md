# 新增智能体框架（Provider）开发指南

[文档索引](README.md) · [Transport 行为矩阵（架构真相源）](provider-transport-matrix.md) · [统一注册与投递路由](provider-delivery-routing.md) · [Provider 身份证据](provider-caller-identity.md) · [专属指南索引](providers/README.md) · [测试指南](testing.md)

本文记录把一个新的智能体框架接入 VOKO 时必须完成的设计、开发、验证和文档工作。它是仓库内的长期开发记忆；Provider 机制变化时，应同步更新本文，而不是只在某个实现或测试报告中保留经验。

本文只定义**开发实现规范**。通道顺序、投递结果、路由缓存、Binding 所有权和灰度不变量以 [Provider Transport 行为矩阵](provider-transport-matrix.md) 为唯一真相源；注册和操作者排障以 [统一注册与投递路由](provider-delivery-routing.md) 为准；测试命令和真机证据以 [测试指南](testing.md) 与兼容性矩阵为准。不要在本页或 Provider 专属页重新定义这些通用规则。

## 当前架构基线（2026-08）

当前 Provider 主链路已经统一为：

```text
Provider Catalog → Runtime Registry → Dispatcher → Delivery Executor → Session Coordinator/Binding Store
```

- **Catalog** 描述 family、transport、优先级、能力和安全策略；**Runtime Registry** 负责 `start/stop/restart/healthCheck` 及 availability 事件；**Dispatcher** 是唯一的跨 transport 路由、降级和结果分类执行者。
- `src/core/dispatcher/providers/` 中的实现是 transport，不要再增加分散在 `src/index.ts`、旧 handler 或 Provider 内部的跨通道路由分支。OpenClaw WebSocket、Hermes HTTP 的专属配置也应通过 Catalog 的 `create(context)` / `getProviderConfig()` 注入。
- `openclaw-cli` 仍是 Catalog 中的 CLI fallback transport；旧的 `openclaw-handler-cli` 兼容入口已经删除，新的 Provider 不得引用或重新创建这类旧入口。
- `pull` 是按需消费能力，不是常驻 transport，也不进入 Push/Steer 路由缓存。所有 Agent 都必须保留 Pull 结果，即使没有任何自动 Push 通道。
- 当前已启用 `feature:provider_modular_dispatch_v1` 的 family 使用 Dispatcher 统一持久化 Session；新 family 仍建议先以 `shadow` 灰度，再切换 `enabled`，不得跳过契约测试直接启用。

本指南以下内容以这套架构为准；行为细节以 [Provider Transport 行为矩阵](provider-transport-matrix.md) 为准，专属 Provider 文档只补充差异，不得覆盖矩阵规则。

## 1. 先确定接入的两个方向

“接入 VOKO”可能指两个完全不同的方向，立项前必须写清楚：

- **Agent → VOKO**：智能体框架作为 MCP/CLI 客户端，调用 VOKO 注册、发消息、Pull、`whoami` 等工具。这通常只需要配置 VOKO MCP 或调用 VOKO CLI，不等于 VOKO 已能把访客消息 Push 给该框架。
- **VOKO → Agent**：VOKO 作为运行时，通过 WebSocket、HTTP、ACP、Attach 或受限 CLI 把访客消息投递给该框架。本文主要描述这个 Provider 方向。

如果只验证了第一种方向，不得在兼容性矩阵或专属文档中宣称自动 Push 已可用。

## 2. 开发前必须回答的决策

在写代码前形成一页简短设计，至少回答：

1. 稳定的 Provider family 是什么？使用小写短横线形式，例如 `claude-code`；历史名称只作为 alias。
2. 是否存在多个真实实例？`backend_instance_id` 必须表示 Provider 自己可验证的实例/profile/alias，不能使用 transport、工作区名称或 VOKO Agent ID冒充。
3. 支持哪些 transport？优先级是什么？每个 transport 是否同时支持 `push` 和 `steer`？
4. Provider 是否返回稳定的原生 Session ID？如何创建、恢复、判断不存在？
5. ACP、CLI、HTTP、WS之间能否恢复同一个原生 Session？不能恢复时不得声称“精确降级”。
6. Provider 如何标识当前调用者？是否提供可信实例和 Session/thread证据给 `whoami`？没有证据时应显式选择 Agent，不做进程、最近文件或握手猜测。
7. 消息投递结果如何分类：`delivered`、`not_delivered`、`outcome_unknown`、`rejected`？
8. 无图形环境如何完成 Provider 自身登录和模型配置？哪些步骤必须由用户操作？
9. Windows、Linux、macOS分别有哪些官方入口、shim、wrapper和配置差异？
10. 访客消息如何在无工具、无写权限、无项目配置的安全边界内运行？

不能回答 Session、结果分类和安全边界时，先以 Pull-only 接入，不要先写一个会串会话或重复投递的 Push Provider。

## 3. 代码接入点

### 3.1 Provider Catalog

在 `src/core/dispatcher/provider-catalog.ts` 增加 family 和 transport：

- `type`、`aliases`、显示名称；
- `requiresInstance`；
- 包含 `pull` 的 `defaultDeliveryModes`；
- 每个 transport 的唯一 `id`、`mode`、`priority`、`operations`、模块路径和 `safetyProfile`；
- 如构造函数不是标准形式，增加明确 factory，而不是在多个入口分散特判；
- 提供无副作用 `preflightDelivery`；模型驱动的 loopback 必须由调用方明确同意。

`pull` 始终是最终兜底。Catalog 的默认顺序、注册预检、状态页和 Dispatcher 必须一致。

当前 `ProviderTransportDefinition` 的关键契约是：`id`（全局唯一）、`family`、`mode`、`priority`、`operations`、`capabilities`、`modulePath`、`safetyProfile`、`sandboxPolicyId` 和 `create(context)`。`create(context)` 可以读取该 transport 的受控配置，但不得在 Catalog 中增加 `factoryKind`、Provider 名称分支或跨 transport fallback。Catalog 的 `preflight`/`loopback` 只能用于显式的注册或测试流程，不能把模型调用偷偷放入 `isAvailable()`。

`delivery_modes` 的解释固定为：`null` 使用默认优先级并保留旧数据的 Pull fallback；`[]` 表示不允许 Push、只留库；非空数组严格按用户给出的顺序选择；`pull` 只表示按需接收。修改该字段后必须同时清理 Agent 的 meta、push、steer 路由缓存；Provider 恢复也不能越过显式顺序抢占当前通道。

### 3.2 Backend 类型和别名

在 `src/core/agent-backend-types.ts` 增加默认类型、显示名称和必要 alias。规范化必须只有一个 canonical family；不要让 `foo-cli`、`foo-acp` 成为两个互不兼容的 Provider 身份。

如存量数据库需要修正 `delivery_modes` 或类型名称，使用幂等 schema migration：

- 只修改能精确识别的默认旧值；
- 不覆盖用户自定义顺序或 Pull-only选择；
- 事务化、可重复执行、失败回滚；
- 涉及 schema 版本时遵守备份和旧版本门禁。

### 3.3 Runtime Resolver

在 `src/core/runtime/agent-runtime-resolver.ts` 增加真实运行入口解析，使以下位置使用同一结果：

- 注册预检；
- Doctor；
- Dispatcher/Adapter 真正 spawn；
- Provider 自身健康检查。

解析结果应包含实际入口和 `pathEntries`。不要执行 `.bashrc`，不要通过 shell 启动，不要只用 `command -v` 后又在 spawn 时使用另一套 PATH。Unix 要避免误选 WSL 中的 Windows shim；Windows 要覆盖 `.cmd`、`.ps1`、Node wrapper和官方安装目录；macOS要验证 GUI 应用附带 CLI 的实际位置。

入口存在只表示“可执行文件可解析”，不表示登录、模型、连接或进程健康。

### 3.4 Provider Adapter

在 `src/core/dispatcher/providers/` 实现一个或多个 transport。优先复用：

- `CliAdapter`：受限非交互 CLI；
- `AcpAdapter`：ACP生命周期、共享连接和 epoch 防旧回调；
- `PushProvider`：availability、健康、精确 Session恢复接口。

每个 Provider 至少正确实现：

- `match(agentId, meta)`：只判断归属；
- `isAvailable(agentId)`：轻量、无模型调用的实时可用性；
- `push(payload)`；
- `steer(...)`，或明确标记不支持；
- `healthCheck()`；
- `start()`/`stop()`，释放进程、连接、监听器和定时器；
- availability事件，使 Dispatcher 路由缓存立即失效；
- `canRestoreExactSession()`/`acceptsBinding()`，如支持跨 transport恢复。

不要在每条消息前做完整网络探测或启动模型。长连接/进程状态变化通过事件刷新路由缓存，每次投递只做轻量守卫。

### 3.4.1 生命周期、availability 与路由缓存

Provider 状态变化统一发出：

```ts
{
  providerId, backendType, mode, agentId?,
  operations: ['push', 'steer'],
  available, reason, generation
}
```

`providerId` 必须是 Catalog 中的精确 ID（例如 `openclaw-ws`、`openclaw-cli`、`hermes-http`），不能只写 `openclaw` 或 `hermes` 这样的 family 名。Runtime Registry 负责订阅、去重和转发事件，`stopAll()` 时必须解除监听器，动态 `addProviders()` 也不能重复订阅。

Dispatcher 以 `agentId + operation(push|steer)` 隔离路由缓存，缓存命中只调用当前 Provider 的同步、无副作用 `isAvailable(agentId)`；默认 TTL 为 30 秒，generation 用于防止在途请求把旧 Provider 写回缓存。事件只失效受影响的 Agent/operation，不取消在途 Promise，也不重放原消息。Provider 不得自己选择另一个 Provider、修改 Dispatcher 缓存或执行跨通道重试；这些职责全部由 Dispatcher 完成。

CLI 的单次模型错误、授权等待或超时不应直接把整个 CLI 标记为不可用；只有入口、profile 或基础配置确定不可用时才发 `available=false`。ACP/Attach 的 session 崩溃按 Agent/session 粒度失效，共享进程退出才做 Provider 级失效。

### 3.5 注册预检和实例选择

在 `src/core/registration-orchestrator.js` 中补充框架检测、实例枚举、配置变更计划和 readiness。要求：

- 检测、Doctor和实际执行共用 Runtime Resolver；
- 只把真实 ready 的自动通道提供给注册流程；
- 所有结果保留 Pull；
- 修改第三方配置前返回 `changePlan`，只有主人明确批准后才执行；
- MCP/普通 CLI Agent调用不能绕过主人确认；
- 同一个 Provider实例可以服务多个 VOKO Agent，不以实例重复阻止注册。

如果 Provider没有稳定实例概念，`requiresInstance=false`，不要虚构实例。

## 4. Session、Conversation 与精确路由

新 Provider 必须接入统一路由模型，不得自行维护“最近会话”：

```text
messageId / replyToRouteId
  → provider_message_routes
  → provider_routing_conversations
  → Provider原生Session
```

必须遵守：

- VOKO Conversation作用域包含 Agent、Provider family、真实实例、原生 Session、私聊/群聊和频道。
- 原生 Session ID只保存在本机数据库，不进入普通日志、Web正文或提示词。
- 明确回复使用 Route恢复原生 Session；没有明确关系且存在多个候选时绝不猜测。
- 私聊和群聊使用各自 Resolver；群聊非法或越权 Route必须 fail-closed。
- transport切换不能改变有效的原生 Session。
- 精确 Session不可恢复时转 Pull；不得创建新 Session后声称完成精确回程。
- `turnId`/`replyId`必须原样关联具体回合；多个异步回合不能使用 FIFO 猜测。
- VOKO或Provider重启后，持久化 binding仍应恢复；内存缓存只用于加速。
- Agent可见接口只交换VOKO `conversationId`：发送结果、Pull和历史消息均返回可空ID；`get_chat_history`可按ID过滤；`list_routing_conversations`用于重启后发现。不得向这些接口暴露Provider原生Session ID。
- 新增字段必须保持兼容：未传`conversationId`继续走频道级旧流程，旧消息返回`conversationId: null`；只有显式传入非法或越权ID时才fail-closed。

Provider原生 Session失效时，将 binding标记 stale。本条消息是否允许创建新 Session取决于投递是否确定未发生，不能无条件重试。

### 4.1 Session Coordinator 的边界

使用现有 `ProviderSessionCoordinator` 和 `ProviderConversationBindingStore`，不要为新 Provider 建第二套 binding 表或内存“最近会话”。Coordinator 负责 caller-origin / VOKO-managed binding 的解析、pending 预留、版本校验、激活、stale/discard 和配置变化失效；transport 只接收已经解析的 binding，恢复或创建原生 Session，并在 receipt 中返回实际 `nativeSessionId`、`providerInstanceId`、`deliveryMode` 和 `adapterType`。

同一 adapter 的短暂断线可以继续使用 binding；跨 ACP、Attach、CLI、HTTP、WS 切换时，只有明确证明能恢复同一个原生 Session 才能复用，否则必须创建独立 binding 或留在 Pull。caller-origin binding 不因后台 availability 或自动 fallback 改写。并发创建必须通过 bindingVersion / pending 事务收敛，不能由 transport 直接写表绕过 Coordinator。

## 5. 投递与诊断实现边界

新 Provider 必须实现并测试统一的投递结果、availability、Pull 保留和
`messageId`/`turnId` 幂等语义；这些语义的具体定义和不可变不变量只维护在
[Provider Transport 行为矩阵](provider-transport-matrix.md)，本页不再复制一份运行时规则。

实现时特别确认：

- transport 不选择其他 transport、不修改 Dispatcher 路由缓存、不自行跨通道重试；
- `not_delivered`、`outcome_unknown` 和 `rejected` 的分类必须来自真实发送阶段，不能用统一的“失败”掩盖结果不确定性；
- Pull-only 和后端能力诊断必须是只读的，不启动 Gateway、不调用模型、不改变 IM 心跳；
- 新增或变更 `delivery_modes`、Provider 配置和 binding 时清理受影响的缓存，并覆盖 availability generation 和并发 Session 测试。

状态字段、`methods[]` 和 `voko doctor` 展示以行为矩阵为准；注册和操作者排障请链接到[统一注册与投递路由](provider-delivery-routing.md)。

## 6. 安全约束

Provider接入不是获得本机任意操作权限。必须：

- 默认无工具、只读、非交互、临时工作目录；
- 禁用项目级配置、技能、MCP、shell、编辑和外部目录访问，除非产品明确需要并经过单独安全设计；
- 不通过 `shell=true` 拼接访客文本；优先 stdin或参数数组；Windows参数必须避免 cmd元字符注入；
- 不把 API Key、Token、原生 Session、HMAC指纹、完整配置路径或完整消息正文写日志；日志记录 Provider、通道、阶段、耗时、长度和安全错误类别即可；
- 不读取或执行 shell启动文件以获取凭证；Provider凭证由其自身配置或受控环境提供；
- `preflight`、Doctor、状态页和 `whoami` 都必须只读、无模型调用、无自动学习或改绑；
- 旧异步回调使用 lifecycle epoch/turn claim隔离，Provider停止或超时后不得复活并发送回复；
- 清理握手定时器、子进程、stream transport、文件监控和事件监听器。

## 7. `whoami` 与可信调用者身份

Provider family可以由注册类型准确确定，但同类型多 Agent时仍需要可信实例/Session证据。新增 Provider时同步评估 `docs/provider-caller-identity.md`：

- 只接受 Provider官方生成的环境变量、原生 Session/thread ID，或 VOKO托管 Adapter注入的上下文；
- ACP/CLI/HTTP/WS是 transport，不进入持久身份唯一键；
- `connectionId`只表示当前连接，不作为持久身份；
- 不通过最近文件、最近进程、workspace名字、模拟握手或启动一次模型来猜身份；
- 没有唯一证据时返回选择要求，由用户显式指定 Agent。

`whoami`只负责调用方属于哪个 Agent；Conversation和消息 Route由收发消息流程解析，不能混在一起。

## 8. 自动化测试清单

至少增加以下测试，文件位置按现有 Provider测试命名惯例选择：

### Catalog与解析

- Catalog完整性、transport ID唯一、默认模式包含 Pull；
- family alias归一化；
- Windows/Linux/macOS入口解析；
- 最小 PATH、NVM、`~/.local/bin`、WSL混合 PATH、wrapper/shim；
- Doctor、注册预检和spawn使用相同入口。

### 生命周期与路由

- start/stop幂等、共享连接single-flight、旧epoch回调失效；
- availability变化刷新 Push和Steer路由；
- 同 Agent两个Session向同一对端交错发送，乱序回复不串台；
- 不同Agent、不同访客、私聊/群聊同 ID均隔离；
- 并发首次创建不产生重复 Conversation/Session；
- VOKO重启、Provider重启后恢复；
- 主通道终止后只回复一次，恢复后下一条重新升级；
- 精确 Session不可恢复时转 Pull，不投递到最近 Session。

### 结果和安全

- `not_delivered`允许安全降级；
- `outcome_unknown`不重投；
- `rejected`不错误降级；
- 超时后子进程和监听器清理；
- 访客文本不能注入命令、放开工具或读取项目；
- 日志、Web、MCP、Doctor不泄露正文、Token、原生 Session或本机路径。

### 消息类型和旁路

- 文字、图片、文件；
- 私聊、群聊明确回复；
- Web直接回复和选择 Conversation；
- 主人介入和 `steer`；
- 在线、离线、重连补拉；
- Pull游标隔离且不重复广播。

测试命令、测试层级、隔离约束、覆盖率和真机报告格式统一维护在[测试指南](testing.md)。Provider 贡献至少要把 Catalog、Resolver、生命周期、Session、结果分类、安全边界和故障恢复纳入对应测试层级；不要在本页复制命令清单。发布前使用测试指南规定的 `test:ci`、E2E 和 `github:preflight` 门禁，真实凭证只允许放在本机忽略文件中。

## 9. 验收证据要求

真机验收不是本页的运行操作说明，而是 Provider 进入兼容性矩阵和专属指南的证据门槛。实现者必须在[测试指南](testing.md)和[双机生产测试手册](dual-machine-production-testing.md)规定的环境中提交脱敏结果，至少覆盖真实安装/登录、首条消息、Session 续接、主备通道、断线恢复、IM/Provider 重启和安全边界。

Provider 专属命令、版本、实例语义和已验证平台写入[兼容性矩阵](provider-compatibility.md)及 `docs/providers/<provider>.md`；本页不重复这些环境差异。未完成证据的 family 只能标为 Pull-only、实验性或未验证，不得在 Catalog 或文档中宣称自动 Push 已支持。

## 10. 文档与发布门禁

完成真机验收后才创建 `docs/providers/<provider>.md`，并更新：

- `docs/providers/README.md`；
- `docs/provider-compatibility.md`；
- `docs/provider-delivery-routing.md` 的推荐顺序；
- `docs/provider-caller-identity.md` 的可信证据；
- `docs/providers/linux-real-test-*.md` 和对应平台结果；
- 必要的中英文用户可见i18n文本。

专属文档固定包含：

1. Agent → VOKO与VOKO → Agent两个方向；
2. 安装、已验证版本、PATH；
3. 登录、模型和无图形环境准备；
4. Provider type、真实 instance语义、注册模式；
5. 推荐通道顺序和适用条件；
6. Session创建、恢复、降级、Pull；
7. `whoami`证据和手动选择条件；
8. Windows/Linux/macOS差异；
9. 安全边界、排障命令、已知限制；
10. 真机验证范围和日期。

未完成真机验证的 Provider只保留 Pull或兼容性说明，不自动生成专属指南，不使用“已支持”“已验证”措辞。

## 11. 完成定义

只有同时满足以下条件，才能认为一个新智能体框架已接入完成：

- canonical family、alias、instance语义明确；
- Runtime Resolver、Catalog、注册预检和实际spawn一致；
- 推荐通道和所有备通道有明确健康、降级和恢复语义；
- 原生 Session持久化且多Session不串台；
- 结果分类防止重复投递；
- Provider停止和VOKO退出时资源全部释放；
- `whoami`有可信证据或明确手动选择路径；
- 自动化、真机、重启、双机和安全测试通过；
- 专属文档只描述真实验证过的能力；
- 完整 `npm test`、包构建和密钥扫描通过，工作区不包含凭证、数据库或本地Provider状态。

如果任一项尚未完成，应在兼容性矩阵和专属文档中明确标为 Pull-only、实验性或未验证，不能用最近Session、默认实例或自动重试掩盖缺口。

## 12. 当前版本的额外收尾检查

提交前逐项确认：

- `src/core/dispatcher/provider-catalog.ts` 中 transport ID 唯一，所有 family 默认保留 `pull`，Pull-only family 不伪造 Push 可用性；
- Provider 通过 `ProviderRuntimeRegistry` 接入 availability，`stopAll()` 后无重复监听，事件带精确 `providerId` 和 generation；
- Dispatcher 的 `push`/`steer` 缓存、TTL、generation 和 `delivery_modes` 顺序测试通过，`outcome_unknown` 没有跨通道重投；
- Session 由 `ProviderSessionCoordinator` 收敛，跨 transport 不传递不兼容 binding；
- `voko doctor --json` / `--deep`、runtime snapshot 和 Web 状态能区分 IM 在线、自动接收能力和 Pull-only；
- Windows npm shim、Unix shebang、缺失命令、路径变化和 ACP 握手失败均有 Resolver/Adapter 测试；
- 不实现或调用已删除的旧 handler/旧 factory 入口，`npm run test:ci`、`npm run test:e2e` 和 `npm run github:preflight` 均通过。
