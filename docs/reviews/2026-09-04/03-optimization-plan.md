# VOKO 优化计划 v1

计划 ID：`voko-lite-review-2026-09-04-v1`

状态：`AWAITING_USER_APPROVAL`。首审、独立对抗复核及综合裁决已完成；尚未批准，禁止开始产品修复。

源码基线：`a6e8f35d93940dfd021e443ab332060062aab181`。批准后如 HEAD 变化，先针对本计划涉及的文件核对漂移；不得在旧行号上盲目打补丁。

## 目标与范围

在保留 VOKO Lite 的本地运行、现有 Provider 适配、精确会话、E2EE 和公开接口兼容性的前提下，修复经两位专家核实的授权与可靠性缺陷，补充必要验证。默认不做微服务拆分、数据库替换、全局权限引擎、通用任务队列或密码协议重写。

本计划批准后由当前任务连续执行；机器可读的阶段、依赖与状态见 `execution-plan.json`。它是执行台账，不是已经启动的后台程序。最终结论以 `02-adversarial-review.md` 和本文综合裁决为准，不能把首审报告的每一项自动当成修复任务。

## 本次批准包含的设计选择

1. 好友批准采用明确的肯定操作；兼容现有文本入口时只接受去除首尾空白后的完整肯定命令，不从任意句子中搜索“同意”等片段。含糊回复不授予白名单，不调用模型猜测授权；不擅自把已经resolved的普通主人介入改回pending或重写介入状态机。
2. 单一活跃主人模式下，浏览器会话必须属于当前主人。切换时撤销旧主人会话；不得把全局当前账号身份赋给另一个浏览器留下的旧会话。
3. `/ws` 和控制台完整事件流收紧为当前主人会话或既有实例凭据可访问。匿名保留 `/health` 及既有非敏感静态页面；完整消息、审计及控制台事件不向匿名订阅者开放。此项包含可见性变化；不要求本地运行时先云登录才能启动。
4. 已启动的 CLI 如果无法证明从未接受任务，失败结果按 `outcome_unknown` 处理，不自动跨通道重投。可能少一次自动 fallback，这是避免重复外部副作用的明确取舍。
5. 离线同步优先可靠顺序：遇已知暂时处理失败时停止推进该频道，其他频道可继续；不为了吞吐跳过未处理缺口，也不假设每个整数序号都必须有消息。
6. 本轮不新增依赖，不改变公开加密协议，不迁移或清理用户历史数据。确认需要这些变化时暂停对应事项，先形成增补设计。
7. R08 的前置长度检查只算部分缓解。保留现有正则语义；不在此次自动执行中禁用用户规则、引入新正则引擎或把整个同步入站链改为异步。

## 每项通用工作流

1. 阅读受影响真实调用链和现有回归；在隔离环境写最小行为复现，旧实现必须因对应缺陷失败。
2. 按最小范围修复，复用当前机制；不得仅为测试方便复制生产算法。
3. 运行定向回归，包括反例和不受影响的合法行为；对可量化优化记录修改前后相同数据集结果。
4. 另一位代理对实际 diff 做对抗复核，检查绕过路径、错误分类、并发、兼容性和过度设计。已获用户对本计划的批准覆盖此复核，不必逐项再问。
5. 更新台账的证据与状态；只对通过验收的事项标 `done`。可以创建仅含该批次内容的本地提交作为可逆检查点，不推送。

## 阶段及验收

### S0：隔离基线与失败分类

- 在批准时基线创建独立 `codex/` 工作树，隔离数据库、日志、Provider 配置和测试服务，不复用正在运行的构建目录。
- 本轮观察到本地 Node26.7，CI 使用22/24。准备独立 Node22 环境，不替换全局安装；记录 Node/npm、锁文件、提交与依赖状态。
- 必要时 `npm ci` 恢复锁定依赖，运行一次现有 `npm run release:gate:code`。环境错误、既有失败与本次新增失败分开记录。
- 基线失败先确认是否阻止待修路径验证；不降低门槛，不自动扩展成无关全仓修复。
- 验收：后续每个用例均使用隔离数据；基线退出码和失败清单可追溯；生产服务和当前用户修改未受影响。

### S1：局部授权、输入边界与协议正确性

事项：R01、R03、R04、R09、R16。

| 事项 | 最小改动 | 必须通过的行为验收 |
| --- | --- | --- |
| R01 好友授权 | 替换子串授权判断，保留明确批准的幂等效果 | 不同意/不通过/不OK/引用同意均不授予；明确批准一次生效；普通介入回复不被误处理 |
| R03 名单对象归属 | 按记录ID反查真实Agent和名单类型，验证当前主人，再执行范围限定的更新/删除 | 自己Agent+他人记录ID拒绝；跨名单类型拒绝；id-only合法旧调用兼容且必须鉴权；server-managed语义保持 |
| R04 A2A路径 | 拒绝点目录并在删除前校验目标严格位于根目录内，优先保持正常ID格式兼容 | '.', '..', 根/父目录不能触发删除；正常任务可准备清理；Windows路径边界；仅临时或模拟FS |
| R09 凭据扫描 | 每类格式遍历全部匹配，逐个应用占位符例外 | 合成占位符前后顺序不影响非占位符拦截；仅示例仍允许；不输出凭据内容 |
| R16 MCP id | 按id存在性和协议类型校验，保留0及合法字符串响应关联 | tools/list、tools/call id0返回原id；通知不响应；非法id有明确协议错误；初始化不退化 |

主要路径：`src/core/access-control-api.js`、`src/mcp/tools.ts`、`src/a2a/attachment-workspace.ts`、`src/core/audit.js`、`src/mcp/transport/http.ts`。

复用测试：`test/mcp-access-notification.test.js`、`test/a2a-attachment-workspace.test.js`、`test/audit-safety-engine.test.js`、`test/lite-mcp-contract.test.js`；现有文件缺少合适隔离入口时增加一个聚焦的行为测试文件。

### S2：浏览器身份与敏感事件边界

事项：R02、R11；依赖S1名单授权修复完成。

- 统一当前主人会话解析，账号切换撤销旧主人的会话；不能无差别删除全部session，因为新主人的Cookie可能已在activate之前创建。兼容旧数据库尚未初始化 session 表的启动流程。
- 不只测当前浏览器退出：创建两份A会话，仅退出/切换其中一份，另一份必须失效。覆盖Cookie、CSRF、大小写归一和同账号重新登录。
- 两条敏感WS流复用已存在的身份验证、Host与Origin检查；实例token路径也不得跳过Host/Origin，缺少Origin不等于认证成功。浏览器使用Cookie，原生客户端使用既有实例凭据，凭据不得出现在URL、公开HTML或日志中。
- 登录前/会话失效的页面不得持续重连敏感流；登录后恢复；注销/过期后已建立的敏感连接也失效，不能仅在握手时检查一次。账号切换已有进程重启可复用；其他失效可在广播前校验或沿用集中会话撤销通知。保留基础健康检查和本地启动能力。
- 使用真实路由/WS组件验证；浏览器Cookie用例显式清除Playwright默认 `x-voko-token`，否则不计验收。

主要路径：`src/core/local-web-session.js`、`src/core/owner-switch.ts`、`src/core/local-http-security.js`、`src/index.ts`、`src/web/index.js`、`src/web/live-events-ws.js`及相应Web客户端。

复用测试：`test/owner-switch.test.js`、`test/web-security-regressions.test.js`，新增/扩展两种WebSocket的组件及登录浏览器用例。此项因收紧事件可见性，必须在文档说明。

### S3：离线消息提交、缺口与分页

顺序：R06 → R05 → R07；不可逆序用分页放大未修的缺口/重复风险。

- R06：每次入队操作提供可被调用方await的失败结果；队列尾部仍能继续执行。事务提交成功后才能转发普通 `collected` 消息。审查所有既有调用方，避免新增未处理Promise拒绝。
- R06验收：BEGIN、写入中途、COMMIT失败时普通Provider转发次数为0；直接await该写入作业能收到失败，随后成功作业正常执行。`syncOfflineMessages`外层已有catch并return0，本轮保持该数值返回兼容，验证它记录明确同步失败、不打印成功完成，也不再发布collected；不假定改队列后外层会自动reject。额外观察UI、系统通知、支付/审核介入与E2EE路径，不得把仅修复 `collected` 宣称为整轮同步原子化。
- R05：现有checkpoint作为成功扫描进度；处理已知失败位置，不以数据库MAX覆盖它。关注目前预处理整页E2EE再处理普通消息的顺序，不能只在后一个循环加break。优先按服务返回的可靠顺序逐条处理，遇暂时失败停止该频道；保留永久忽略和合法自然序号缺口。
- R05验收：101暂时失败、102存在时重试101；重启后仍可恢复；永久失败可推进；重复/乱序/混合E2EE与普通消息不重复执行。旧版本只有MAX没有checkpoint的情况需明确初始化策略，不能未经设计回放全部历史任务。
- R07：按协议有界补拉，满页继续、达到时间/页预算调度续拉；重复页/未前进游标及时退出并记录。owner变化/退出、网络失败均可停止；其他频道不会被一个失败频道无限阻塞。
- R07验收：0/99/100/101/250条、空页、重复页、暂时失败、owner切换；最终补齐且已完成工作不重投。

主要路径：`src/core/database.ts`、`src/core/offline-sync.ts`、必要的 `src/core/messenger.ts` 调用边界；复用 `test/offline-sync.test.js`、`test/offline-sync-coordinator.test.js`、`test/checkpoint-store.test.js`。

如发现需要历史数据迁移、持久化新outbox或全面重写同步事务，则停止该设计部分；先交付已能最小修复且有独立验收的错误传播，不隐藏剩余问题。

### S4：Provider执行证据、附件寿命与真实停止契约

事项：R12、R10、经实际生产调用链收窄后的R13。

- R12：分离诊断文本与重试资格。pre-spawn失败或可靠协议证明未接受执行才允许安全fallback；进程已启动后的泛化日志不能证明未执行。先补“部分操作后401”的失败回归，并保留真正的启动前失败恢复。检查generic CliAdapter的 `_classifyResult`、catch及Provider覆盖逻辑，防止unknown再次被日志提升；同一transport的managed-session重试也必须服从此约束。
- R10：附件清理归属于实际Turn完成或确认取消；保留send的“已接受”语义，不能简单改成所有发送都等待最终回复。不确定结果采用有界保留与后续清理，避免既提前删文件又无限占盘。复用现有final/activeTurn机制。
- R13：首审通用coalescer异步探针不等于生产Provider排空证明。先用真实Dispatcher+可控Provider复现：关闭前接收的排队项、active任务、stop后新请求各自如何处理；包括dispatch内部尚未进入 `_conversationRoutes` 的A2A延迟setTimeout。只修改由此证明的Dispatcher admission/队列/停止缺口；不以“给flushAll多一个await”作为完整修复。
- R13最小目标：停止开始后不接受或启动新的执行；尚未提交的任务与已接受但结果未知的任务状态分开；有界等待/取消，只按真实取消确认收尾；未知结果不能标成可安全重投。保留可观测终态，避免直接清空计时器后失去状态。
- 验收：延迟读附件成功、final后清理、并发隔离、unknown保留后清理；startup failure安全fallback、partial execution不fallback；queued/active/stop期间enqueue/异常/超时的真实Dispatcher行为，无跨owner续跑和未处理拒绝。

主要路径：`src/core/adapters/cli-spawner.ts`、`src/core/adapters/cli-adapter.ts`、`src/core/dispatcher/delivery-executor.ts`、`src/core/dispatcher/providers/openclaw-ws.ts`、`src/core/dispatcher/index.ts`、必要的 `src/index.ts` 停止顺序。

复用测试：`test/lite-cli-output-limit.test.js`、`test/lite-dispatcher-routing.test.js`、`test/lite-openclaw-provider.test.js`、`test/provider-attachments.test.js`、进程生命周期测试。全局容量背压和通用coalescer API清理不自动混入该批次。

### S5：会话查询正确性及有依据的效率改进

事项：R17；R15与其同批评估，R14只建立基准。

- 先对同一个关系结果进行待回复过滤，再count和分页，保持公开参数和排序兼容。不能单纯扩大limit再在JS过滤。
- 复用查询结果减少逐条查询。先用代表性数据检查EXPLAIN和查询次数，再决定最少必要索引；不引入缓存同步或反规范化计数表。
- 验收：前20条已回复+第21条待回复时首页能返回后者，filtered total一致；私聊/群聊、同时间戳、系统状态、空会话、关键词组合保持契约。
- R14仅做合成附件10/25MiB、并发1/4的事件循环延迟/RSS基准与成本分析；未测得明确瓶颈不改IO/密码实现。即使测得瓶颈，本v1也不自动追加流式加密重构；记录为后续有证据事项。

主要路径：`src/mcp/tools.ts`及必要索引定义；测试基于真实SQLite而非只模拟查询返回值。性能结果独立记录为基准，不冒充修复完成。

### S6：A2A坏项隔离与分发制品检查

事项：R19、R18。

- R19先验证可信claim关联和已验证信封能否确定独立task。现有 `UNIQUE(task_id,command_sequence)` 仅去重，accept/begin流程没有已证实的前序完成guard；不能直接map改for/catch后宣称顺序安全。只有证明独立性及同task保守停止策略后，才局部隔离其他独立task；关联不可信/无法确定时保持失败关闭并标 `deferred_design`，不自动新增顺序状态机。
- R19验收：坏项位于首/中/尾；同task前序缺失不得执行后序，确知独立task才可继续；不相信坏payload自称的taskId来决定其他任务权限；错误签名永不执行、不伪造成功ACK。retry JSON解析、过期信封与重复项分别覆盖，诊断有界且不泄露payload。无法小范围保证这些不变量即暂停设计扩展；不能声称外部持续重投已解决。
- R18扫描实际待发布文件集合/同一不可变tgz的文本内容；构建后扫描与后续发布使用同一个制品，不能为了扫描另打一个不同的包。保留现有Gitleaks/CodeQL，不增加安全平台或长期凭据。
- 验收：仅出现在build/README的合成敏感格式会失败；未打包test fixture不误算包泄露；扫描日志只含规则/路径/行号；制品摘要和交付对象一致。二进制扫描范围明确，不承诺regex能审计所有WASM内容。

主要路径：`src/a2a/bridge-worker.ts`、`scripts/scan-package-secrets.js`、必要的 `package.json` 与 `.github/workflows/release-npm.yml` 门禁步骤。允许修改工作流文件以补检查，禁止触发发布。

复用测试：`test/a2a-bridge-worker.test.js`、`test/lite-package-secret-scan.test.js`；全部使用模拟网关与临时打包fixture。

### S7：审计长度边界的有限缓解

事项：R08-partial。

- 将已有128KiB输入限制放在任何自定义正则匹配之前，保持原有超限拒绝语义。
- 验收：超限输入不执行自定义正则；普通关键词、Unicode、规则优先级保持；隔离的501字节高回溯用例仍作为残留风险证据，不改断言假称消失。
- 完整R08状态仍为 `deferred_design`。Worker/新引擎/语法限制需单独给出兼容、同步事务、延迟和失败语义设计后再批准。

### S8：整体门禁、对抗复核与交付

- 按 `04-validation-and-boundaries.md` 运行汇总代码门禁、Web E2E、包契约与可用的静态安全扫描。
- 对实际diff进行独立对抗复核，发现范围内遗漏则自动修正并重跑必要测试；不得为了收尾削弱授权、错误分类、测试或扫描。
- 进程/路径/Provider生命周期改动需要三系统验证。若当前仅macOS可用，记录本机结果与Windows/Linux缺失，不能声称跨平台验收完成；不自动连接真实账号或未经批准的远端。
- 交付聚焦的本地提交或补丁、变更说明、逐项结论、测试证据、剩余风险和回退说明。最后检查git diff/status，确认没有用户数据、凭据和无关改动。

## 明确暂缓与不采用

- R08完整正则计算隔离：暂缓；本轮只有长度前置的部分缓解。
- R14同步IO/全Buffer加密重构、R13全局容量背压：缺少基准或设计，暂缓；允许本地合成基准和观察记录。
- R19超出已证明独立task范围的坏项恢复：没有现成前序guard可直接复用；先验证，不能成立则暂缓完整隔离方案。
- 统一Tool Broker/ABAC、分布式队列、数据库替换、全仓模块拆分、所有Provider重写：没有本轮必要性，不采用。
- MCP SDK私有访问：记录兼容性风险，修id=0不顺带替换整个transport。
- 历史缺口批量回放、用户数据库迁移/清理：本轮不授权，避免重复执行过去任务。
- 独立云端/Chatroom审计、密码学专门审计、全Provider真机矩阵：属于未覆盖或单独验收，不暗示已完成。

## 完成与回退

- `done`要求：最小失败用例、最小修复、定向验证、独立diff复核均有证据；必要整体门禁未通过时不能报全部完成。
- `partial`、`deferred_design`、`rejected`、`blocked`必须保留，不能为了清零问题而改成done。
- 代码回退以独立工作树的聚焦提交/补丁为单位；不重置用户主工作树。默认没有生产或用户数据变更，因此不需要自动回滚生产数据库。
- 若需要后续跨平台/真实交付验证才能确认，先交付本地已验证结果并列缺口。安装、登录、VOKO注册、IM连通、Provider可执行与实际回复交付分别报告。

批准本计划只授权上述本地优化与验证，不授权推送、公开安全报告、合并、打标签、Release、npm发布、生产部署或后台定时运行。
