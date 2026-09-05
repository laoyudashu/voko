# VOKO Lite 独立首轮整体代码审查

- 审查日期：2026-09-04；源码基线：`a6e8f35`（`Merge pull request #58 from laoyudashu/codex/npm-update-source`）。
- 仓库：`/Users/laoyu/Documents/ChatGPT/open_voko`。本报告所有相对路径均相对于该目录。
- 角色：首轮代码审查专家代理。上一轮对话发现只作为定位线索；以下重新阅读了当前源码，并新增独立隔离探针，不把历史复现当成本轮亲自运行的测试。
- 动作边界：只读产品源码、配置、测试和文档；仅写本报告和 `/tmp/voko-primary-probes-2026-09-04.cjs`。未构建、未修改产品文件、未启动服务、未访问真实账号或用户数据库、未调用云服务。未运行完整测试套件。
- 探针命令：`node /tmp/voko-primary-probes-2026-09-04.cjs`。10 组探针全部通过；使用 `node:sqlite` 的 `:memory:`、源码临时 transpile/AST 提取、模拟 DB/HTTP/通知和 100ms VM 预算。它们证明各自描述的分支行为，不等同于生产攻击或完整 Provider E2E。

## 1. 产品意图和审查范围

已读 `README.md`、`README.en.md`、`docs/README.md`、`SECURITY.md`、`package.json`、Transport 行为矩阵、Provider 权限与身份文档、E2EE 安全模型、消息安全文档。未发现仓库内另有 AGENTS.md；遵循用户提供的 AGENTS.md。

VOKO Lite 是本地 Agent 通信运行时：把 IM、A2A/REST Gateway 和本地 Provider 接起来，负责身份、会话精确路由、消息审核、执行生命周期与回复回程。它不是通用 Agent 本身，也不是云平台的完整源码。A2A 是独立数据库和长轮询，群聊/A2A/REST 不承诺 E2EE；本地 Lite 和真实 Provider 是可信明文端点。因此，群聊使用 TLS、本地数据库有明文、系统依赖外部 Provider 并不是本次认定的漏洞。

覆盖：主入口与本地 HTTP/WS、MCP handlers/transport、主人会话与 ACL、审计引擎、在线/离线消息协调、Provider dispatcher 与 OpenClaw/CLI 关键路径、附件暂存、A2A mailbox/execution/task-store、E2EE 出站策略和持久化接口、构建与发布扫描门禁。抽查而非逐行审完全部17类 Provider；云端 Gateway/server、独立 Chatroom、Rust/WASM 密码学实现未做独立密码学审计，OS 真机和并发压力未执行。

现有值得保留的设计：随机本地 MCP Token、Host/Origin 防护、Web CSRF、SQL 参数绑定、A2A 签名和 principal scope、Provider unknown outcome 不自动跨通道重试、E2EE 已激活会话 fail-closed、A2A 持久化 inbox/outbox、发布相同不可变 tarball。下面的修复应在这些结构上收敛，不建议重新拆微服务、替换数据库或重写全部 Provider。

## 2. 证据与优先级

- E1：本轮真实源码函数/方法隔离执行观察到错误行为；明确哪些依赖被模拟。
- E2：当前源码直接控制流或 SQL 可证明；本轮未运行完整场景。
- E3：风险/效率推断，需要测量或产品契约裁决，不能计作已验证线上故障。
- P1：应在本轮优化前段解决的授权/数据一致性/破坏性缺陷；不等于公网无需认证可利用。
- P2：功能正确性、条件性可用性或防护覆盖缺口。
- P3：量化后择机改进。

下列 R01–R19 为此报告稳定ID，第二位专家应逐项接受、修改或拒绝，禁止只沿用首轮结论。

## 3. 发现及最小解决办法

### R01 [P1, E1] 拒绝好友申请被解释为批准

- 证据：`src/core/access-control-api.js:151–177`，155行 `/同意|通过|好的|ok/i`；`src/core/messenger.ts:1075` 实际调用。
- 触发：主人对 `private_req_` 介入记录回复“不同意”（“不通过”也由代码可推断）。真实函数在模拟存储中进入 INSERT 并调用批准通知；探针不发送真实消息。
- 防护/反例：只有好友申请记录、有 agentId/visitorId、尚未白名单才新增；一般介入回复不走该分支。纯“拒绝”不会被匹配。
- 影响：明确的拒绝意见实际授予访问白名单。
- 最小修复：结构化批准/拒绝动作，兼容文本时采用完整字符串的明确肯定命令集合；模糊文字保持待人工裁决，不用追加无限否定词清单。
- 验收：不同意、不通过、不OK、引用同意文本均不授予；显式批准一次生效；重复批准幂等；非好友申请无副作用。
- 复杂性：低；无需模型审批服务或新增权限框架。

### R02 [P1, E1局部+E2调用链] 旧主人 Web 会话未与当前主人身份绑定

- 证据：`src/core/local-web-session.js:48–59` 只校验存在/过期，返回 ownerEmail；`src/core/owner-switch.ts:85–121` 切换不撤销表中旧会话；`src/web/index.js:705–710,723–733,984–998` 接受会话，而 Agent guard 使用全局 currentOwnerEmail。
- 触发：同一本地运行时切换 A→B，另一浏览器/Profile保留 A 的会话和 CSRF。请求认证仍是 A，但资源归属检查以 B 判断。
- 防护/反例：Cookie HttpOnly/SameSite、CSRF 随机校验仍有效，不能凭空构造有效会话；重启不能清除持久化会话。默认本地服务，不是公网任意用户绕过。
- 影响：旧会话有机会访问/修改新主人的资源。本轮探针确认 store 只按 token恢复 A身份，完整跨账号链本轮为源码验证；之前对话的完整内存复现属于历史证据。
- 最小修复：请求鉴权要求 session.ownerEmail === activeOwnerEmail；账号切换事务内撤销旧 owner 会话（表可能尚不存在需兼容）；资源鉴权用已认证 principal。先做这两点，不要求全局权限系统。
- 验收：A Cookie 切换B后所有敏感操作401/403；B新Cookie可用；A/B大小写归一；同账号token刷新策略明确；旧数据库启动兼容。
- 复杂性：低–中；如果未来同时在线多主人，应另立设计，不能混入此修复。

### R03 [P1, E2] 黑白名单记录 ID 与鉴权 Agent ID 脱钩

- 证据：`src/mcp/tools.ts:3507–3512,3526–3531` remove id分支；`src/mcp/tools.ts:3946–3963` 只检查params.agentId；`src/core/access-control-api.js:99–105` UPDATE/DELETE只按id。
- 触发：有MCP/CLI调用权，传自己Agent ID和另一个主人Agent的ACL记录ID，或略过可选agentId。若记录ID未知，不能声称无需前提可枚举利用。
- 防护/反例：显式传其他主人的agentId会被拦；按agentId+visitorId删除分支已限定归属；server_managed记录只移除人工覆盖不删除服务器权威记录。
- 影响：改变其他Agent的名单状态，也可跨whitelist/blacklist类型操作，因为id分支无list_type约束。
- 最小修复：按id读取实际agent_id/list_type→对真实对象授权→参数匹配→scoped SQL。共用remove辅助函数要求预期owner/agent/list类型，不把用户参数当真实资源归属。
- 验收：自己agent+他人id、不同list_type、无agentId、记录不存在、server-managed记录覆盖；合法删除保持返回兼容。
- 复杂性：低；可在现有入口和ACL模块完成，无需通用ABAC引擎。

### R04 [P1破坏性, E2且可达性未证] A2A点目录任务ID进入递归删除

- 证据：`src/a2a/envelope.ts:7` ID regex允许点；`src/a2a/attachment-workspace.ts:15,70–82` ID='..'后path.join指向root父目录并rm recursive；`src/a2a/execution-service.ts:48`调用prepare。
- 触发：通过网关签名校验的信封携带 gatewayTaskId='..' 且有附件。正常网关可能总生成UUID：本仓库无法证明外部caller控制该字段，不能称为已证实公网任意目录删除。
- 防护/反例：`src/a2a/bridge-runtime.ts:56–58` 有签名验证；字母数字正常ID不逃逸；附件数/格式/大小另有检查。这些不改变点目录计算缺陷。
- 影响：满足触发时可能删除A2A数据父目录。未运行实际删除，本轮为源码证据。
- 最小修复：拒绝'.'/'..'，并在递归删除前用resolved路径确认目标严格位于root内且不等于root；或将opaque任务ID哈希映射目录。保留现有信封协议兼容优先。
- 验收：'.'/'..'/空/编码与Windows路径变体拒绝；正常ID可准备与清理；模拟fs断言无root/父目录rm。不得在真实数据目录做破坏复现。
- 复杂性：低；无需沙箱平台改造。

### R05 [P1, E2] 离线重试起点被后续已保存消息越过

- 证据：`src/core/offline-sync.ts:189–196` startSeq=max(DB MAX,checkpoint,legacyCursor)+1；282–311遇暂时E2EE失败留blockedAt，331–334限制检查点，但后续普通消息仍落库。
- 触发：101暂时解密失败、102已持久化，检查点100；下一次从103请求。暂时错误不需要恶意输入即可出现。
- 防护/反例：永久失败允许推进是正确语义；当前blockedAt本身试图fail-closed，但DB MAX覆盖其作用；仅连续成功的历史不会触发。
- 影响：失败消息不会被此同步路径再次请求；不能据此断言生产端所有其他恢复路径永远不能找回。
- 最小修复：以成功扫描/处理的已提交检查点为权威，MAX仅限明确的旧版本迁移且不可跨已知待重试失败位置；已扫描进度不是“每个整数序号都必须有消息”，过滤/不持久化可产生合法自然缺口。先停止处理该channel失败后的后续条目是低复杂度选项。保留永久忽略语义，不能把所有E2EE失败都无限重试。
- 验收：101暂失败102成功再同步101重试；永久失败只推进一次；乱序/重复/重启/legacy cursor迁移；不得重复执行已完成Provider Turn。
- 复杂性：中；先利用现有checkpoint，若不需要乱序吞吐，不先建通用gap服务。

### R06 [P1, E2] DB事务失败仍转发离线消息

- 证据：`src/core/database.ts:617–625` enqueueDbWrite返回void且catch吞异常；`src/core/offline-sync.ts:319–345`提交前收集payload，等待queue后350–353无条件forward。
- 触发：部分handle成功、后续写/COMMIT失败并ROLLBACK，collected仍保留。
- 防护/反例：数据库本身有事务和rollback；全部成功没有此问题；幂等消息插入只保护成功持久化的记录，不能保护回滚后已开始的Provider副作用。
- 影响：没有持久化证据的消息被执行，恢复时可能重复执行。
- 最小修复：enqueueDbWrite返回此项作业Promise并保留失败；内部tail可以catch以使后续队列继续，但caller要await原始job。collected只在提交成功后发布。先修传播，不要求上来增加新的分布式outbox。
- 验收：BEGIN、第二次INSERT、COMMIT注入失败均不forward，调用方可见失败，下次队列仍可运行；正常成功仅一次forward。
- 复杂性：中，需要核查调用方兼容及未处理拒绝；可保留void调用兼容，显式消费失败处必须await。

### R07 [P2, E2] 离线积压同步只有一页

- 证据：`src/core/offline-sync.ts:199–227` limit100单次fetch；初始化协调器450–474是一次性ready/fallback，不会因full page自动drain。
- 触发：某channel积压>100条且后续无新的恢复触发。
- 防护/反例：后续重连/手动同步可能继续补齐，因此不是绝对永久丢失；少于100正常。
- 影响：启动后的积压恢复不完整，用户以为已恢复但旧消息延迟处理。
- 最小修复：按服务分页契约循环或调度continuation，页数/时长预算后yield；遇R05暂失败停止该channel并保留重试，不跳游标。
- 验收：0/99/100/101/250条，重复页、空页、网络失败、owner switch取消；断言最终补齐且不重复执行。
- 复杂性：中，与R05同一批更合适；不引入消息中间件。

### R08 [P2条件性可用性, E1] 自定义审计正则仍可造成主线程高回溯

- 证据：`src/core/audit.js:95–104`局部regex过滤不足；109–124自定义正则先执行，128KiB限制后执行。本轮501字节输入及`/a+a+a+a+$/`在100ms VM预算被中断。
- 触发：已配置高回溯规则（主人或有管理工具能力的调用者添加）；外部仅提供字符串可放大执行成本。
- 防护/反例：pattern长度512以及嵌套量词/反向引用/环视拒绝挡住部分模式；默认普通关键词没有此例；不是所有规则均危险。
- 影响：同步regex与IM/UI/dispatcher共享事件循环，可能延迟心跳及消息处理；本轮未量化生产并发卡顿。
- 最小修复：输入限制前置，并给允许的规则一个真正可保障的计算边界；优先受限regex语法或线性时间匹配。若必须完整JSregex兼容，使用可终止worker预算，不能Promise.race伪超时。
- 验收：高回溯样例必须在独立worker/进程预算下跑；普通关键词/Unicode/现有合法规则兼容；超限返回明确不可用/拒绝，不能静默允许。
- 复杂性：中；这是需要复核专家裁决兼容性/最小方案的一项，不建议同时引入新DSL和worker池。

### R09 [P2, E1] 首个凭据占位符遮蔽后续真实格式匹配

- 证据：`src/core/audit.js:53–60`每种模式仅exec一次；looksLikePlaceholder后不继续。本轮两个合成github格式字符串复现，未使用任何真实凭据。
- 触发：同一消息同种token格式先出现placeholder，后出现非placeholder格式。
- 防护/反例：其他模式或主人自定义规则可能另行拦；非placeholder单独出现能拦。不能称为所有DLP失效。
- 影响：违背内置凭据披露检测预期。
- 最小修复：遍历该模式全部匹配，对每一个匹配独立执行placeholder豁免；保留空匹配安全。
- 验收：placeholder在前/后、多种token格式混合、仅示例、零长度模式防护；无害前缀不削弱原有拦截。
- 复杂性：低，不需要外部DLP服务。

### R10 [P1附件功能, E2] OpenClaw WS发送完成即删除待读取附件

- 证据：`src/core/dispatcher/providers/openclaw-ws.ts:1648–1660` stage→sendToSession→finally cleanup；1301–1341 send只等订阅/发送，无Provider读取或Turn完成等待。
- 触发：附件以staged_path传给OpenClaw，Provider发送后异步读取该路径。
- 防护/反例：纯文本无影响；Provider若在极短时间内先读取可能偶然成功，不代表生命周期正确；receipt中的attachmentAccessed为null也准确表示未验证，但transportDelivered=true不能证明文件仍可读。
- 影响：模型实际处理时路径已失效，附件回复失败或空泛。
- 最小修复：将cleanup ownership绑定该Provider Turn最终完成、明确取消成功或安全的过期清理；timeout但执行结果未知时不能立刻删仍可能读取的文件。
- 验收：send已完成而模拟Provider尚未读时文件仍存在；final后清理；并发Turn不交叉清理；超时未知态有受限保留与后续清理。
- 复杂性：中，复用现有_activeAgentTurns/final机制，不让sendToSession整体变成等待最终回复以免改变dispatcher接受语义。

### R11 [P2本地边界, E2] WS事件流认证与HTTP/MCP认证不同步

- 证据：`src/index.ts:1668–1681` '/ws'只检查Origin；`src/core/local-http-security.js:56–61`无Origin允许；console WS `src/web/live-events-ws.js:21–30,43` token默认空退化Origin。
- 触发：能访问loopback端口的本机进程，不带Origin；不需有效Web Session/MCP Token。需结合事件内容确定具体隐私影响。
- 防护/反例：服务loopback、Host/Origin限制阻挡一般恶意网站跨域；不能说任意公网网站可直接读取；同OS用户本来可访问数据文件，风险取决于本机多用户/受限进程边界。
- 影响：未认证本地订阅者获得事件数据，与敏感本地接口认证目标不一致；不是E2EE密码学失效。
- 最小修复：浏览器WS复用有效owner Web Session+Origin；本地程序用明确token，避免URL长期凭据；账号切换主动断开旧会话。无需独立认证服务器。
- 验收：无Origin无凭据拒绝；合法Cookie浏览器正常；错误owner/过期/注销断开；MCP token不被无条件当浏览器身份。
- 复杂性：中，有现有浏览器初始只读UI兼容，需确认产品要不要匿名只读事件并缩减payload。

### R12 [P1重复执行风险, E1分类器+E2fallback] CLI整段输出关键词导致过度认定未投递

- 证据：`src/core/adapters/cli-spawner.ts:62–71` stdout/stderr拼接匹配401等→not_delivered；`src/core/dispatcher/delivery-executor.ts:33–50`仅此态允许fallback。本轮合成“文件已修改，后续API401”输出被分为not_delivered。
- 触发：Provider非零退出，已做部分操作，日志带认证/网络类关键词；另有可用备选transport或后续Pull执行。
- 防护/反例：unknown默认不重试是正确设计；pre-spawn ENOENT/连接前认证失败确实可以安全not_delivered；不是任何日志401都会自动重试，须非零失败且路由满足条件。
- 影响：已执行的任务被再次提交。
- 最小修复：生命周期/结构化错误证据决定safe retry；进程已启动且无“从未接受执行”证据默认unknown。关键词仅用于用户诊断分类，不能提升为重试授权。
- 验收：spawn失败可fallback；部分stdout+退出1+401不能fallback；真实结构化preaccept拒绝行为兼容；async队列接受后错误不能重投。
- 复杂性：中，先保守fallback规则再按Provider补强可靠证据，不重新设计全部transport。

### R13 [P1/P2视停机影响, E1局部+E2] Turn drain漏掉已启动项；队列缺乏总量约束

- 证据：`src/core/inbound-turn-coalescer.ts:132–139`只遍历pending；162–180自动flush将项从pending移入inFlight；`src/core/dispatcher/index.ts:2219–2223`stop只清deadline/stop providers。本轮maxMessages=1立即flush后flushAll已resolve而flush回调未完成。
- 触发：自动flush已触发且仍执行时开始停机/切换owner。总量部分：maxMessages/maxCharacters只限制单batch，持续入站可堆积inFlight链或多scope。
- 防护/反例：同scope有串行链，避免同会话并发；单batch有限；正常全部空闲停机无问题。上层停机可能有宽限期，不能仅从flushAll断言每次丢任务。
- 影响：调用方不能把flushAll完成当成执行已排空；停机可中断任务并留下未知状态。背压缺口是待压力验证的E3，不应与已证明drain bug混成一个无条件DoS。
- 最小修复：定义close/drain契约：先拒绝新enqueue，再等待pending+inFlight，设置有界停机期限并持久化/报告未完成项。总量限制单独用可量化queue预算，不新建调度系统。
- 验收：自动flush中、queued同scope、多scope、flush异常、drain期间新请求、超时未知态；无未handled拒绝、无跨owner续跑。
- 复杂性：中，需与现有主进程shutdown顺序联合验证。

### R14 [P3, E2机制/E3影响] 附件同步IO和重复整包处理占用主线程

- 证据：`src/core/dispatcher/provider-attachments.ts:93–114` 同步读/写/再读/hash/递归清理；`src/e2ee/v2-attachment.ts` 全Buffer分配与加密。已有文件大小限制，不能断言无限分配。
- 触发：较大合法附件、多Agent并发；未运行基准，不报告具体p95改善比例。
- 影响：推断事件循环延迟、峰值内存放大；当前是否用户可感知需测。
- 最小修复：先测10/25MiB附件、1/4并发的event-loop lag/RSS；优先移除不必要再读、async文件IO和总并发限制。大buffer crypto若测得CPU瓶颈再worker；不要先重写流式密码协议。
- 验收：文件完整性/权限/拒绝symlink保持；相同基准前后延迟与RSS比较，不使用脆弱绝对耗时单元断言。
- 复杂性：低–中；属于可跳过的性能阶段，不应阻碍授权修复。

### R15 [P3, E2查询数/E3影响] 会话列表N+1查询

- 证据：`src/mcp/tools.ts:2258–2297` count+列表后每条1次lastMsg，needsReply再2次；最坏约3N+2。
- 防护：每页上限100，不是无限query；SQLite本地可能仍很快，未测负载。
- 影响：大消息表时更多同步查询；实际瓶颈需EXPLAIN/数据量测量。
- 最小修复：优先与R17合并，用一次集合查询得到latest visible、needsReply/计数，合适索引；先保留接口offset兼容，不强迫所有调用方改cursor。
- 验收：同timestamp排序、系统/E2EE状态排除、空会话、群聊、查询次数上界；10k/100k合成消息EXPLAIN与耗时。
- 复杂性：中；不引入缓存同步和反规范化计数除非查询实测不够。

### R16 [P2, E1] JSON-RPC id=0被误当通知

- 证据：`src/mcp/transport/http.ts:77–80` `if (!msg.id)`；实际createHttpTransport在模拟Router/response下id=0 tools/list返回202。
- 防护/反例：正整数/非空字符串id正常；initialize分支在此前，所以可能初始化成功后工具调用才无响应。
- 最小修复：按字段存在性判断notification并独立校验合法id；保留0和合法字符串。
- 验收：0、1、空字符串（协议允许性按本项目采用JSON-RPC2.0契约确认）、无id、null、非法对象id；tools/list/call错误响应保留原id。
- 复杂性：低。直接访问SDK _requestHandlers是维护风险；修此bug不必马上更换整个transport。后续可用公开SDK transport，但须协议兼容回归单独立项。

### R17 [P2, E1] 待回复过滤在分页后执行，默认列表可空但实际有待回复

- 证据：`src/mcp/tools.ts:2246–2262,2310–2311` SQL先LIMIT/OFFSET，再JavaScript needsReply filter，total未过滤。本轮AST提取真实方法，模拟前20均已回复、总21，返回conversations=[]/total=21；第21待回复被数据库分页挡住是直接SQL语义。
- 触发：较新的已回复会话占满首页，旧的待回复会话在下一页。默认filter=unreplied，因此影响默认入口。
- 防护/反例：filter=all或翻到正确offset可看到；若客户端一直按total遍历不会永远漏，但空页通常被误解为无待回复。
- 最小修复：needsReply作为关系查询结果，先filter再count/page；count与items使用同一predicate。与R15一起改一次查询比独立缓存更简单。
- 验收：前20已回复+第21待回复，首页应含该条且filtered total=1；群聊/同时间/空会话/关键词复合过滤一致。
- 复杂性：中；不改变公开参数与默认行为。

### R18 [P2覆盖缺口, E1+E2workflow] “包秘密扫描”默认目标未覆盖实际发布产物

- 证据：`scripts/scan-package-secrets.js:8` DEFAULT_TARGETS=['src','scripts','dist','package.json']；package files实际含build/README/assets；`.github/workflows/release-npm.yml:51–69` release gate→e2e→pack，之后没有artifact内容secret扫描。gitleaks CI/git历史检查不等同于最终tarball检查。
- 本轮scanner.listTextFiles(root)确认build/README没有被选入。没有寻找/输出真实凭据，也不声称包里存在泄露。
- 防护/反例：编译源码一般来自已扫描src；Gitleaks覆盖tracked变更；不可变tarball与OIDC发布设计正确。缺口是额外生成/复制到build或未包含target的文本。
- 最小修复：扫描准确的pack文件集合或生成后解包的同一tgz，扫描通过的那个artifact继续上传发布；不要为扫描再次build/pack产生不同包。
- 验收：临时fixture在build/README藏合成secret应失败、test-only未打包fixture不误报；输出只路径/规则/行号；通过artifact摘要与发布artifact一致。
- 复杂性：低–中。二进制/WASM无法靠文本regex全面证明无secret，报告扫描范围即可，不要求加入多产品安全平台。

### R19 [P2条件性可用性, E1] 一项坏A2A claim阻断整批其他有效任务

- 证据：`src/a2a/bridge-worker.ts:47–53` claim.items.map整批验证，任何异常在有效项持久化/ack前退出；83–102本地retry列表类似。runtime外层只记录再试。
- 本轮真实worker模拟一有效一无效信封，pollOnce拒绝，createTask/ack均0。生产持续阻断还取决于网关重投与隔离策略，本仓库不可证实；过期合法签名也可能触发验证错误。
- 防护/反例：签名失败必须拒绝，这是正确的；不能为可用性直接ack未验证命令；如果网关剔除坏项或下一批不再携带，则只是一次延迟。
- 最小修复：逐项隔离验证错误，继续处理其他有效项；未验证项不执行/不冒认ACK，记录有界诊断。先用现有错误统计，不先建设DLQ平台；网关隔离协议需求另审。
- 验收：坏项位于首/中/尾均不影响有效项exactly-once接收；签名错误绝不执行；不输出未信任payload；retry中单条坏数据不阻断其他ready项。
- 复杂性：低–中，注意同一task command sequence仍必须遵守顺序，不可跳过同task的安全关键前序。

## 4. 需要复核而不应直接当漏洞修的项目

1. MCP Caller身份来自共享token下的`X-VOKO-Caller-*` headers（`src/mcp/transport/http.ts:97–117`），Owner Pull authorizer使用该身份匹配binding。具有同一OS用户权限的Agent能读本地token/环境，因此这些是声明或绑定线索，不是强隔离principal证据；但trusted remote模块默认master switch关闭，普通本地MCP本来是主人授予高权限工具。是否需每Agent capability凭证是产品威胁模型决策，不能直接P1重写认证。
2. `manage_audit_rules`可经MCP修改全局审核规则，未见单独主人批准边界。这是管理面与执行面共享凭据的设计风险，但README明确MCP用于管理；先确认哪些Provider工具配置允许普通执行Agent访问，再决定分离管理能力。不能把tools annotations当授权防护，也不能无授权删掉用户依赖的管理工具。
3. `soft_deny`放行同时提醒在普通消息与E2EE路径是一致的既有软规则语义（messenger明确写“已放行发送，请关注”），不能因名称含deny就断言应阻断；可改善命名/文档但不是本轮授权修复。
4. A2A accepted lease在outcome unknown后不自动释放属于防重复执行，不能用“到期一律释放并重试”优化。明确已完成但产物上传失败是否应恢复context是单独可靠性设计，证据不足暂不立缺陷。
5. 暂未证实SQL注入、命令注入、E2EE密码学破坏或生产泄露。未执行依赖漏洞最新查询；package版本不能直接等同于安全漏洞。
6. README中中英文Provider实测状态有轻微更新不同步（例如OpenHands）；文档状态不是本轮代码路径缺陷，可并入文档维护小项。

## 5. 建议给执行计划的依赖与边界

- 首批低风险正确性：R01、R03、R04、R09、R16。每个先最小失败回归，修到通过，独立小提交/小批次。
- 会话鉴权：R02和R11共同梳理现有Web Session登录/切换/WS客户端；不要把所有本地只读UI突然变为云登录依赖。复核确认产品契约后实施。
- 消息可靠性：先R06错误传播，再R05检查点，随后R07分页；否则分页只会扩大重复或缺口。R13须配合停机顺序与Provider unknown语义。
- Provider：R12分类证据与R10附件完成期分别回归，保持dispatcher接收/执行/最终回复状态区分。
- 查询正确性：R17优先，能一起解决R15就统一集合查询；不能为消除N+1引入新的状态同步复杂性。
- 审计正则R08：需复核专家选择最小计算边界方案，兼容决策明确后才自动实现。
- R18打包门禁：可本地fixture与CI脚本验证；本优化批准不等于授权npm发布、版本升级、生产CD。
- R19逐项隔离遵守同task排序；R14只在基准证明收益时做。大型权限Broker/微服务/分布式队列/数据库替换不在默认自动优化范围。

最终批准前要求：第二位专家逐项确认优先级、必要触发条件、反例和方案复杂性；进入执行清单的每项都有确定的失败回归、最小改动范围、验收与回退方式。对无法在本地无账号环境验证的真机交付路径明确标记待真实验收，不以unit通过宣称完整支持。

## 6. 明确覆盖矩阵与探针断言

| 模块/边界 | 本轮深度 | 实际验证及限制 |
|---|---|---|
| README/产品、云服务与Chatroom边界 | 文档阅读 | 本地Lite与公网协议分工；未审独立云端代码 |
| Web Session/owner switch/ACL | 关键鉴权链深查 | session恢复及好友授权真实函数探针；ACL/owner guard本轮静态调用链 |
| MCP HTTP/工具包装与会话列表 | 关键函数深查 | id=0、post-page filter真实方法探针；管理面principal只列设计观察 |
| 审计/可选模型 | 关键规则深查 | ReDoS隔离VM与synthetic凭据探针；未调用真实模型 |
| 离线IM/检查点/数据库写队列 | 完整相关函数静态追踪 | 三项缺陷E2；历史内存复现未冒充本轮运行 |
| Turn coalescer/dispatcher stop | 关键函数深查 | 自动flush未排空探针；无真实停机/压力实验 |
| Provider transport | OpenClawWS/通用CLI深查，其他抽样 | CLI分类探针；未运行17类真机矩阵 |
| A2A inbox/execution/lease/outbox | 主要类静态追踪及worker探针 | 坏项阻断批次；无网关签名控制/线上重投证明 |
| E2EE | 出站路由、审核、附件与存储接口抽样 | 不审计Rust/WASM密码学、不读取用户密钥；未完整ratchet恢复E2E |
| 性能/资源 | 热路径代码审阅 | 同步IO和N+1机制确认，吞吐/延迟/RSS影响E3观察，无基准 |
| 构建/发布 | package scripts/scanner/workflows阅读 | scanner目标探针；未build、pack、上传、发布或最新CVE查询 |
| Windows/Linux/macOS | 代码路径抽样 | 仅当前macOS隔离Node探针，未真机跨平台执行 |

探针脚本产生的10项断言（全部PASS）：
1. R01 实际好友审批函数将“不同意”进入模拟grant/notification。
2. R02 实际session store仅按Cookie恢复owner A；active-owner中间件组合为静态证据。
3. R09 第二个synthetic credential被前置同格式placeholder遮蔽。
4. R08 实际规则引擎501字节输入超过VM100ms预算。
5. R13 自动flush已在执行时，flushAll提前resolve。
6. R17 实际list_conversations方法在模拟SQL分页后过滤返回空且total21。
7. R12 实际classifyCliFailure把部分执行后401日志分为not_delivered。
8. R16 实际HTTP transport将tools/list id0返回202。
9. R19 实际A2ABridgeWorker一坏一好claim均未持久化/ACK，抛出验证错误。
10. R18 实际scanner默认文件清单不含build/README。

R14、R15和R13中全局背压影响是性能/容量观察，不纳入“已验证线上漏洞数量”；R04、R11、R19须保留报告所列触发条件和信任边界。
