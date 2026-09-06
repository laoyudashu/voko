# VOKO Lite 第二位专家独立对抗复核

日期：2026-09-04；基线：`a6e8f35d93940dfd021e443ab332060062aab181`；仓库 `/Users/laoyu/Documents/ChatGPT/open_voko`。相对路径均相对该仓库。

## 结论

首审包含多项真实正确性问题，但不能把 R01–R19 都计作已证实生产漏洞或默认全自动修复。最重要的修正是：**R13 的异步 flush 探针没有复现生产 MessageHandler 的语义；真实 callback 返回 void，等待 coalescer 不等于等待 Dispatcher/Provider。** R02 普通 logout 会撤销发起切换的那个会话；成立路径是其他独立会话或不经 logout 的切换。R03 是已有 active-owner 管理边界的资源定位缺陷，不是已建立的 per-Agent 隔离被突破。R04 的目录不变量确定错误，但签名 Gateway 对任务 ID 的外部可控性尚未证明，按低成本破坏防护修复，而不是声称公网利用。

R08 完整计算边界修复不进入默认实施；本轮只准入前置长度检查，必须标为有限缓解。R14、R15 独立性能改造以及 R13 全局背压不进入默认修复。R15 仅当 R17 正确性 SQL 重写自然消除 N+1 时随同完成。R11 可在用户明确批准“敏感事件仅认证访问”的可见性收紧政策后实施。

本复核已阅读 README、历史 H01–H16 台账、验证边界、相关源代码与定向测试。README 明确 Lite 是本地通信运行时，MCP 是管理入口；本地 Lite/Provider 是可信明文端点，A2A/群聊/REST 没有 E2EE 承诺。审查不能借本次局部问题改造通用 Agent 安全架构。

## 证据规则与操作边界

- **E1**：本轮执行真实函数/方法的隔离探针；注明替身与 AST 提取，不能外推生产端可达性。
- **E2**：当前源码调用链或实际 SQL 可证明；未跑真实运行时。
- **E3**：条件性影响或性能推断，需额外复现/测量/契约裁决。
- P1 表示修复排期前段，不表示 CVSS 结论或无需认证漏洞；P2 为局部功能/条件防护问题；P3 为测量后决定的优化。
- 未修改产品代码、配置、build；未构建或跑完整套件、未启动服务、未联网 Provider、未读取真实账号库/密钥。仅新增 `/tmp` 报告与探针。脚本使用 Node26.7，不能替代 CI Node22/24、三OS、真实Provider验收。
- 复跑首审前已通读脚本；其副作用仅合成日志、内存 SQLite、内存 transpile/VM、源码读取/文件枚举。ReDoS 使用100ms VM预算。新增探针只用 `:memory:`、模拟 fetch、模拟 fs、临时生成且仅留内存的 Ed25519 密钥；不执行真实删除。

## R01–R19 逐项裁决表

| ID / 历史 | 独立裁决、证据与优先级 | 最小修复与明确反对的过度设计 | 自动计划准入 / 必要验收 |
| --- | --- | --- | --- |
| R01 / H08 | **已证实 E1，P1**。`access-control-api.js:151–177` 子串肯定匹配会把“不同意”授权；`messenger.ts:1075`有真实调用。非private_req/已有白名单/纯拒绝是反例。 | 用trim及大小写归一后的完整肯定命令集合；模糊回复不授权。当前接口可直接修，不必新增结构化审批协议或模型判决。 | **是**。否定、否定夹肯定、引用肯定、显式同意、重复审批、非好友介入；状态和通知一起断言。 |
| R02 / H09 | **条件成立，关键组合已证实 E1+E2，P1**。普通logout撤销该token；另一A会话仍存活，真实activate后resolve+CSRF成功，Web guard又以B为准。 | 现有各认证入口统一校验normalized session owner与active owner；切换仅撤销旧owner会话，保留预先创建的B会话。拒绝全部删session、另造多租户框架。 | **是**。无实例token的Cookie集成：单会话logout已失效、独立A会话在B激活后401/403、B会话仍可用、OAuth/OTP/reauth/A2A入口、重启及TTL。 |
| R03 / H10 | **资源归属缺陷已证实 E2，P2（授权修复前批）**。`tools.ts:3507/3526` id分支与`3946`的参数guard脱钩；`access-control-api.js:99–105`仅按id。共享管理token已获本地管理能力，不可称每Agent凭据越权。 | 从record取得真实agent/list类型，校验active-owner与可选agentId，scoped SQL；同一owner操作其多个Agent应继续合法。反对per-Agent密钥/Tool Broker/新ABAC。 | **是**。other-owner id、缺agentId、错list type、不存在id、同owner不同Agent、server-managed与same_owner_default语义；合法删除兼容。 |
| R04 / H11 | **目录不变量已证实 E1；外部利用条件未证，P2**。签名合成“..”通过verify，prepare的fs替身观察到父目录rm；真实Gateway签名验证挡住无签名任意输入。 | 仅在workspace目录边界拒绝`.`/`..`并验证resolved目标严格位于root内；复用现有字元规则，避免全协议ID重写或UUID强制迁移。 | **是，明确为破坏防护**。fs替身断言根/父目录绝不删除；合法目录与cleanup；Windows path语义；签名校验保持。 |
| R05 / H12 | **已证实 E1真实sync+checkpoint SQL，P1**。retryable101、saved102使下次请求103；自然稀疏序号不是缺陷。 | checkpoint作为已处理扫描进度，不持续MAX兜底；按channel有序处理遇暂失败停该channel，bootstrap/legacy只作明确迁移。两遍E2EE/ordinary必须一起考虑。反对无限gap表/逐整数连续扫描。 | **是，与R06/R07同批**。临时失败后重试、不连续101/105、永久拒绝、乱序/重复、空页、重启、无checkpoint及legacy；已执行Provider不得重投。 |
| R06 / H13 | **已证实 E1真实队列+sync+SQLite，P1**。COMMIT注入失败，存储0行却forward2。现有catch使waitForDbQueue成功。 | 返回本作业可await的Promise，内部tail保留错误消费及队列续行；仅COMMIT成功发布collected。外层sync目前catch并return0，需明确失败可观察方式，不可宣称自然抛给caller。反对先建outbox。 | **是，限普通Provider转发**。BEGIN/写/COMMIT失败不forward，rollback，后续队列可运行，无未处理rejection；单独记录UI/系统消息/E2EE副作用，不能声称整轮原子性。 |
| R07 / H16 | **已证实 E1，P2**。真实sync对150条仅取100；Coordinator首次ready/fallback不是自动分页。重连可能补齐是反例。 | R05/R06后按现有协议有界续页，检测游标不前进，预算后续调度；不新建消息中间件。 | **是，合并离线批**。0/99/100/101/250、稀疏序号、重复页、网络失败、owner切换、取消与不重复执行。 |
| R08 / H14 | **有危险配置时已证实E1，P2**。501B样例超过100ms，现有局部regex过滤不足；无该规则时反例成立。 | **本轮只前置128KiB检查**。保留同步签名和规则语义；完整可终止计算边界另行设计。反对默认新增引擎、同步spawnSync、通用worker池或批量禁用现有规则。 | **仅有限缓解准入，完整修复否**。超限进入regex前拒绝；旧正常行为保留；必须记录501B仍可触发，不能把项标完全fixed。 |
| R09 / H15 | **已证实 E1，P2**。同模式首个placeholder掩盖后续合成token；单独非placeholder正常阻止。 | 各global模式遍历全部匹配，placeholder豁免仅作用该匹配；保留lastIndex复位。反对移除全部示例豁免或外部DLP服务。 | **是**。placeholder前后/多次、仅示例、每种模式、无害字符串；仅合成格式，不读真实凭据。 |
| R10 / H01 | **生命周期错误已证实E2，用户故障条件成立，P1排期**。sendToSession只到订阅/发送，finally已清staged；实际OpenClaw可能抢先读取，不能说所有版本必失败。 | 将cleanup绑定既有turn-final/已确认取消；明确never-sent失败即时清、unknown受限保留后清；成功push仍是accepted语义。反对使push等待最终回复或加独立附件任务平台。 | **是**。send后延迟读仍成功、final清理、并发turn隔离、订阅失败、断连/unknown/stop、过期清理；真实OpenClaw附件验收另列未覆盖。 |
| R11 / H02 | **匿名本地敏感流已证实E1+E2，风险边界条件成立，P2**。无Origin native接受；恶意网站Origin拒绝。messenger:665 payload含content，console含recentAudit/recentEvents。 | 用户批准后仅current-owner session或现有实例token访问敏感流，两个分支都保留Host/Origin；匿名health和非敏感静态页面保留。反对第二认证服务、长期token进URL/HTML、擅自全站云登录。 | **需本轮显式批准可见性收紧政策后准入**。浏览器初始登录、Cookie/实例凭据、旧owner/过期/注销、恶意Origin、重连；已连客户端失效后不得继续收敏感事件。 |
| R12 / H03 | **分类器错误已证实E1，重复副作用条件成立E2，P1**。真实调用点对非零退出使用分类器，DeliveryExecutor只在not_delivered继续；认证失败文本也可能在写文件后出现。 | 启动前缺runtime或确切spawn失败保持safe fallback；启动后无可信preaccept结构化证据默认unknown；诊断关键词可继续用于提示。检查adapter override/catch不能再次提升unknown。反对禁用一切fallback或全Provider协议重写。 | **是**。pre-spawn ENOENT可fallback，已输出/已工具调用后401/ENOENT不重投、同transport managed-session重试也受约束；保持已证preaccept拒绝。 |
| R13 / H04 | **拆项裁决**：通用flushAll对async callback漏等待E1；生产“coalescer inFlight持有Provider turn”论据**不成立**。Dispatcher stop未等待自身routes可由E2确认，最终丢失/跨owner续跑仅条件性。全局容量影响E3/P3。 | 先用真实MessageHandler→Dispatcher集成复现停止语义，定位`_conversationRoutes`、延迟A2A定时器和provider stop；有界停机+阻止新submit。flushAll可小修但不得冒充根因解决；反对任务系统/泛化队列/默认持久化新表。 | **只准入停机复现及由其确定的小修，背压否**。自动flush中、已accepted WS、排队CLI、延迟A2A、owner切换、stop期间新入站；分清提交排空与最终完成。 |
| R14 / H05 | **机制E2，实际性能收益未证E3，P3**。同步IO/整Buffer确实存在；已有大小上限，未测p95/RSS。 | 只做隔离合成基准；若值得，局部去重复读、async IO/现有并发限额。反对未测先worker/流式密码协议。 | **默认产品修复否**。10/25MiB、1/4并发event-loop/RSS，完整性/权限/symlink保持；未测不得许诺收益。 |
| R15 / H06 | **N+1机制E2，性能严重性未证E3，P3；与R17合并**。本地SQLite一页≤100；并非网络N+1。 | R17集合谓词/查询自然复用最新visible数据即可；不要求一条巨型SQL、不新增缓存计数或强迫cursor。 | **仅随R17自然消除准入**。相同语义下查询工作量及EXPLAIN/合成数据比较，允许简单稳定的少数集合查询。 |
| R16 / H07 | **已证实E1，P2**。id0 tools/list变202；initialize特例仍响应故不能称所有请求坏。 | 明确字段是否缺失及项目协议合法类型；保留0/空字符串合法性；保持原id。反对为修0替换整个SDK transport。 | **是**。0、1、空字符串、缺id、null、非法对象id、tools/list/call/错误响应；SDK私有访问另作维护观察。 |
| R17 / 新 | **已证实E1真实SQL，P2**。前20已回复+第21未回复，默认首页空；offset20可见，filter=all正常。 | filter与count先于分页，共用visible/needsReply谓词；R15能自然合并就合并。保持参数/offset与群聊契约。反对先改变默认列表业务语义。 | **是**。filtered total=1且首页含该条、全量filter、私聊/群聊、控制消息、空会话、同timestamp rowid、keyword复合条件。 |
| R18 / 新 | **制品扫描覆盖缺口已证实E1+E2，P2；泄露未证**。默认src/scripts/dist不含发布build/README/assets文本；Gitleaks不等于最终包扫描。 | 对已生成同一tgz中的确切文件扫描，成功后发布同一摘要制品；沿用现有规则和脱敏报告。反对再次pack产不同制品或加多安全平台。 | **是，仅门禁代码/fixture，不发布**。build/README合成secret应失败，未打包测试fixture不误报，制品路径/摘要一致，文本范围及二进制限制明确。 |
| R19 / 新 | **单次阻断已证实E1，持久饥饿条件成立E3，P2**。整个claim map先verify；坏项抛出使好项create/ack0。Gateway后续是否重投未知。 | 验证失败逐项隔离，让其他已验证独立task前进；坏项不执行、不冒认ACK；不能假定已有前序guard（现有仅去重）；相关task保守停，不扩大为新顺序状态机。反对跳过签名、ACK坏项或默认DLQ平台。 | **条件准入，先证明独立task与同task不越序策略**。坏项首/中/尾、retry JSON/过期/签名错误、同task前序缺失、duplicate、诊断有界且不泄露payload。 |

## 争议展开与首审方案修正

### R02：Cookie切换不能忽略真实清理路径

`src/web/index.js:1517–1520`的`GET /api/logout`确实调用`destroyRequest`及`clearCookie`；“用户点击切换，浏览器一直保留同一有效A Cookie”不是准确的常规路径。`register.js:1184–1188`新登录又设置B Cookie。不能删除这些反例而夸大漏洞。

但该清理只按当前请求token删除，`local-web-session.js:62–65`未撤销A的其他会话。新探针创建两个A会话，只对一个执行真实destroyRequest，再真实stage/activate B，另一A会话仍通过resolve及CSRF。`requireSensitiveLocalAuth`、global sensitiveMutation、authorizeA2AApi不比对session.ownerEmail与currentOwnerEmail；而Agent ownership guard又取全局owner。此组合证实剩余独立会话条件下的身份混用。

B会话在activate前已创建，撤销全部session会误伤刚完成登录的B。最小方案是集中active-owner校验并旧owner定向撤销，不建立新的并行多租户模型。审核验收必须不带`x-voko-token`，否则会绕过Cookie路径。

### R03：共享MCP管理权与对象归属是两回事

`_agentOwnershipError`只在params.agentId存在时执行；记录id不是从该guard已验证的对象读取。即便同一OS管理客户端本来有广泛权限，工具API自己承诺只访问active owner的Agent，按id删除别的owner历史记录仍违反该承诺。应修资源定位，不把它包装为“访客匿名调用MCP”或“Agent A已被强隔离但越权到B”。随机ACL ID会降低猜中概率，不是授权检查；名单列表对owned Agent可给出合法ID是正常行为，不足以证明另owner ID可枚举。

可选agentId应继续允许省略，但从实际记录反查后授权；不必为此做破坏性schema变更。expected list type必须参与校验。`same_owner_default`按visitor移除会设置auto_trust_disabled，而按id直接delete，批准后测试需确认两入口应有相同产品语义；不要把旧入口差异无证据称为server-managed绕过。

### R04：签名不保证文件路径安全，路径错误也不证明网关攻击能力

实际Gateway入口`bridge-runtime.ts:56–58`验证Gateway公钥签名。测试生成自己的临时密钥说明的是“当前验证器接受合法签名的点目录ID”，不是能伪造生产Gateway签名。调用execution前仍需通过任务/绑定/lease等前提；本轮未证明外部用户能指定Gateway签出的ID。

目录根/父目录被递归删除的原语无需实删即可由fs替身确认，成本极小的workspace guard值得默认防护。只在文件系统边界防护即可，不必修改所有opaque协议ID规则或强制换UUID。额外的symlink根目录攻击不是本轮已证明问题，不应据此扩展沙箱平台。

### R05–R07：按已处理消息推进，不按每个整数“补洞”

真实sync探针用SQLite checkpoint与消息表，fetch完全替身。101暂失败、102持久化，下次start103重现成立。永久拒绝推进是产品已有正确语义；序号允许稀疏，101后105不表示102–104必须存在。

目前先遍历所有E2EE消息，然后事务中遍历ordinary，因此“遇第一条失败break”不能只加在第二个loop：后续E2EE可能已经执行，后续普通消息也可能已由online路径写入。最小正确修复应定义每channel按已确认顺序处理/暂停与持久化扫描checkpoint，MAX只做受控bootstrap；不要为了简单补洞重复调用已接受的E2EE Turn。已有get/set/advanceCheckpoint可复用，别引入新数据库模型。

R06不是“数据库所有写错都向外抛”：`enqueueDbWrite`的尾catch吞错，`syncOfflineMessages`最外层也catch并return0。返回job Promise并await后，collected可以不发布，但对上层失败暴露还须明确契约（错误结果/日志还是throw）；不能未经审阅改所有caller为throw。

更重要的是`skipForward=true`并不使handleAgentMessage无副作用。`messenger.ts:665`发UI正文事件，后续还可能发系统通知/计费/介入；E2EE处理则早于该ordinary事务。所批准的R06首先解决“ordinary COMMIT失败仍forward Provider”。如测试发现其他不可逆副作用同样需提交后发生，优先现有callback的短小缓冲/commit后发布；需要跨连接outbox等则停止该扩展并补设计，不能把局部修复夸成整轮原子性。

分页必须放在这两项之后。满100不能无条件用本地MAX继续；使用实际服务扫描序号、检测不前进及空页、预算后yield，并在owner switch停止。不可把每页成功拉取等同每条Provider已经最终完成。

### R08：完整Worker不是本轮最小局部修复

`checkAuditRules`是同步函数；调用包括`messenger.handleAgentMessage:773`、group:923、forwardToAgent:1103、outbound:1456，以及send-message:223、E2EE outbound policy:29、A2A safety gate:7。入站函数在离线事务中同步返回ForwardPayload，改async不仅改变audit.js，而会改变队列、消息顺序、事务生命周期和调用接口。同步等待worker或spawnSync依然占据事件循环等待时间；Promise.race不能中断RegExp。

限定更窄语法/替换线性引擎会改变现有JSregex语义；本轮没有配置清单可以证明兼容。默认全禁regex同样不是无害优化。因此本轮做唯一确定小改：在normalize、取规则、regex匹配前检查128KiB并按原validator拒绝。**这只消除超长输入放大，501B高回溯仍存在，R08保持部分缓解/完整修复未完成。** 另立完整方案前需明确是否保持全部JSregex语义、审核可否异步以及有界失败如何fail-closed，不给批准后实施者三选一自选架构。

### R10：完成信号必须与具体Turn一致

`openclaw-ws.ts:1301`注释本来就写“不等待回复”；push:1653 await的send只订阅/发帧，cleanup:1660发生在实际读取前是可能且确定的寿命缺陷。已经有`_activeAgentTurns`、`_releaseAgentTurn`及final路径，不必再造通用生命周期服务。

不能把所有release都视为确认完成：destroy:1072也释放active turn，断连不证明远端停止。新cleanup应分never sent、final/明确cancel、unknown。受限保留/已有过期清理可避免无限堆积。只等最终reply再resolve push会改变dispatcher的delivery接受语义，不应采用。

### R11：敏感流收紧须作为用户可见政策批准

`/ws`带`agent-wukongim:message`的正文；console初始化含recentEvents/recentAudit，不是只有健康状态。无Origin可被本地native客户端使用；这不等于公网恶意站点可绕过Origin，也不等于E2EE加密被攻破。

建议本轮批准明确政策：敏感`/ws`与`/voko/events/ws`仅current-owner Web Session或既有实例token可用；匿名`/health`及已有非敏感静态页面继续可用。不引入匿名事件副本/公共事件总线，不把长效实例token放URL/HTML。两个身份分支都通过Host/Origin（当前console authToken分支仅比token，不能照搬成为新绕过）。原生客户端用header；浏览器用Cookie。必须补登录后连接、失效提示/停止重连风暴，注销/过期/owner切换后的已连客户端不再收敏感内容。账号切换已有shutdown关连接，但logout/TTL不是必然重启，握手验证一次不够。

这项政策可能使原先免登录控制台的实时敏感数据不可见，应在批准清单明确说明，不能把“无需云服务即可运行本地Lite”误解为所有敏感UI必须匿名展示，也不能未经批准把整个本地UI依赖云OTP。

### R12：保护可安全fallback，拒绝从日志猜执行历史

现有测试`lite-expanded-cli-providers.test.js:40`直接把“Not signed in”文本视为safe fallback，测试反映当前假设，不是执行前失败证据。部分执行后API401文本会进同一个分类器。OpenClaw CLI、Hermes、Goose及generic CliAdapter真实非零退出调用链成立。某些adapter内部managed-session重试也依赖not_delivered（cli-adapter.ts:479起），不应只修Dispatcher的第二transport路径。

保留确知未发送的缺runtime、pre-spawn系统ENOENT/EACCES、协议明确preaccept拒绝。进程启动后通用stdout/stderr提示不够证明未接受，应unknown；文本仍可决定提示“需登录/配额”。不要通过“stdout非空”单一规则推断执行，因为登录提示本身也在stdout，反过来静默写文件也可能没有stdout。generic adapter catch对code/message正则及provider `_classifyResult` override需要检查，防止局部分类器修了又被提升为safe retry。无需此轮统一17个Provider协议；每个保留的safe路径都必须有阶段证据。

### R13：首审探针成立，生产根因归属不成立

通用coalescer支持async flush，flushAll确实只枚举pending；首审probe对此有效。但生产`messenger._dispatchInboundTurn:226–246`返回void，仅调用`dispatcher.dispatch`，`_queueInboundTurn`也未保留执行Promise。新探针抽取真实方法并接pending Dispatcher Promise，coalescer已完成且inFlight为空。故“coalescer漏等待Provider执行”在实际接法下不成立；只修flushAll将无法让生产等待Provider。

上层也不是完全没排空：`index.ts:2038`把flushInboundTurns注册为TaskManager stopper，`shutdownAll:3280`await stopAll；TaskManager倒序停任务。接下来`dispatcher.stop:2219`清deadline并stopProviders，未等待`_conversationRoutes`（1448起）或管理dispatch里的A2A delay setTimeout（1991附近）。Provider stop是否取消/等待本轮未对全部实现证实，因此真实损失不能由类级probe断言。

默认执行只可先写真实MessageHandler/Dispatcher/TaskManager集成停机复现，明确“已经提交”“等待最终reply”“unknown取消”分别如何收尾；在已有Map/标志/timeout结构小改。如果必需新持久化任务系统/跨owner重放语义，暂停R13设计扩展。全局背压单列测量，不随这个已证类bug强行准入。

### R15/R17与R19：集合查询和逐项隔离也有最小边界

R17新probe不再mock分页结果，使用真实SQLite和真实AST方法，确认首页空而第二页有待回复。为过滤所必需的latest visible/needsReply查询可以同时复用到投影，通常能自然削减R15，不要求“一条SQL”作为成功标准。现有群聊needsReply=false、控制消息排除与同timestamp rowid次序必须保留。未读计数现有timestamp-only语义也应先测试清楚，避免所谓性能改造偷偷改消息计数契约。

R19单坏项阻断整次claim已证；后续Gateway如何隔离未知，不能宣称持续DoS。逐项catch不可跳过同task未验证前序后盲目执行后序。进一步读`task-store.ts:98–119`发现acceptCommand仅INSERT OR IGNORE，beginCommand只检查status=received；`database.ts:81`的UNIQUE(task,command_sequence)是去重，不证明前序已处理，last_command_sequence列也未见执行更新。因此不能声称现有顺序guard可直接复用。可先在可信claim关联与已验证信封基础上限定独立task；无法安全确定关联的坏项不可简单略过并执行可能相关后序。也不能相信坏payload自称的taskId来形成任意跨task拒绝列表，更不能ACK未认证项。准入条件是先做混合同task/不同task的确定性测试并明确保守策略，若需要新持久化顺序模型则暂缓该扩展。retry JSON解析也在flatMap内，隔离范围须包括parse/verify；保留合法过期项的既有expireRetry恢复。

## 建议精简执行批次

1. **低成本确定性修复**：R01、R03、R04、R09、R16；先失败用例，局部修到通过。R03按对象归属，R04按破坏防护命名。
2. **会话边界**：R02；R11仅在明确同意敏感流认证政策后同批，先核对B Cookie生命周期，补无实例token的浏览器测试。
3. **离线可靠性**：R06提交后普通forward → R05扫描checkpoint及失败暂停 → R07分页；一个依赖批次，不能先扩大拉取。
4. **Provider**：R12正确分类与保持safe fallback；R10文件随具体turn的寿命；两项各自小范围，真实Provider交付验收另行明确。
5. **查询与制品门禁**：R17并自然吸收R15；R18对同一tarball扫描，范围到门禁验证为止，不发布。
6. **A2A单条隔离**：R19，先验证可信关联下独立task与同task保守停止策略，再小改逐项隔离；现有只有去重，不能假定有前序执行guard。不能小范围保证则暂停此项设计扩展。
7. **有限缓解/验证任务**：R08长度前置明确partial；R13先生产接法停机最小复现再决定既有结构小修。R14、独立R15性能优化、R13背压与R08完整架构方案默认不实施。

执行授权须对应上述具体政策和边界；批准后若需要新增依赖、公开协议变化、历史数据迁移、新持久化状态或跨仓库修改，应先报告具体所需设计，不能把“自动优化”当无限授权。不会推送、发布、CD、清理真实数据库或调用真实账号Provider。

## 探针命令、结果及证明限制

`node /tmp/voko-primary-probes-2026-09-04.cjs`：退出0，10组PASS。本复核重新执行，不使用“首审说通过”替代亲自验证。每组边界仍按首审脚本中mock/AST/VM说明，尤其R13不外推生产。

`node /tmp/voko-adversarial-probes-2026-09-04.cjs`：退出0，8组PASS：

1. R02真实session store+stage/activate：logout当前会话失效，另一A会话及CSRF存活。
2. R04内存Ed25519签名“..”通过验证；unsigned拒绝；真实workspace函数在fs替身中目标父目录；没有实际创建/删除目录。
3. R13真实AST MessageHandler callback返回void，模拟Dispatcher Promise未完成时coalescer已空；直接反驳生产coalescer拥有执行Promise的假设。
4. R11真实授权函数（AST）+安全helper：本地无Origin接受、外站Origin拒绝。
5. R17真实SQL/内存21个会话+真实AST方法：默认首页空、offset20有1条、all首页20条。
6. R05真实offline模块、真实checkpoint SQL和真实队列源码，模拟fetch/消息handler：101暂失败102已存，下次请求103。
7. R06真实offline+队列，SQLite COMMIT注入错误：ROLLBACK后0行，forward替身2次；预期故障日志不代表探针失败。
8. R07同一真实offline对150条模拟远端数据：只1次请求、保存100。

新增probe未调用完整MessageHandler的普通/E2EE消息业务，不能证明该handler内部所有副作用、真实WuKongIM排序或真实Provider重执行；它补强的是同步控制流与SQL证据。R03仍以静态真实guard/id/SQL链为E2，未冒称本复核新增完整MCP端到端越权测试。

当前`git status --short`仅`?? docs/reviews/`（主代理审查记录），HEAD未变。没有运行完整build/test、安全扫描、依赖CVE查询、真实网络或跨OS矩阵；没有审计独立云端/Chatroom与密码学Rust/WASM。此报告不是“剩余代码无问题”的保证。

## 使用的记忆边界

仅复用`/Users/laoyu/.codex/memories/MEMORY.md:115–118`的对抗审查方法与只读约束（对应历史任务 `01a06718-c479-7ca1-ad57-f951a3465823`），所有本报告产品判断都已重新读当前源码；没有用历史上线状态或历史探针作为当前测试结果。

## 综合计划初稿复核

已读取`docs/reviews/2026-09-04/03-optimization-plan.md`的v1初稿。S3/S4整体边界合理；已向主代理要求明确：R06外层sync失败表达、R12 generic adapter override/catch与同transport重试、R13 A2A delay定时器、R01不擅改整个介入状态机。R19顺序guard不存在的收尾发现已单独反馈，S6准入应体现先证明独立task策略，不能仅将map改for/catch后宣称顺序安全。
