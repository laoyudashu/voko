# 三端生产回归与问题修复

用户目标：修复问题并提交，在 macOS 网页端对当前三端全部 Agent 做真实对话测试，遇到问题自动修复和回归，直至完成。目标仍在进行中，不能用少量成功 Agent 代替全部验收。

`execution.json` 保存初始 50 个 Agent 的逐项台账（Mac 17、Linux 12、Windows 21）；最终验收必须重新核对当前清单。历史聊天中已注销的 Agent 不代替当前已注册 Agent。登录、额度、Pull 模式和外部服务限制均要记录，不能伪造成功。

## 第一批：终态回执恢复

最小复现：Provider 已完成，终态回执 deliver 返回 ECONNRESET，原实现立即清理 receiptRequests/receiptSourceAliases，因此后续没有保留的补发上下文。新增测试在原代码上失败，修复后通过。

修复范围：保留不可变终态回执（同一 messageId、sequence、source IDs），仅补发回执；成功后清理上下文。最多 1000 个待补发条目、最多 5 次总尝试、10 分钟有效期、30 秒重试间隔，每轮最多 4 个并发；到期明确记录日志。重试不重新调用 Provider，不放松目录、身份、加密校验，也不伪造业务成功。关闭时停止新补发并清理内存，旧异步结果不能丢弃更新后的条目。失败日志只记录经过约束的错误码，不打印原始错误文本。

这解决暂时交付失败的恢复缺口，不代表 PEER_NOT_FOUND、历史加密锁或 Provider 登录问题已经解决。待补发上下文是实例内存状态，和现有 get_message_result 的实例生命周期一致；没有声称跨重启持久恢复。

验证：类型检查通过；消息回归 56 个 Node 测试和 16 个群消息检查通过；回执/结果存储 10 个测试通过；更早的契约组合 37 个测试通过（数量重叠，不相加）。完整 `release:gate:code` 门禁通过：1537 项通过、2 项既有平台跳过、0 失败；覆盖率基线、类型检查、build、i18n 和源码包扫描均通过。

## 三端部署和第一轮网页证据

第一批 `fa45ecb` 的同一 tarball 已安装到 Mac、Linux（两个现存全局前缀）、Windows；各端先保存包和 SQLite 在线快照。包 SHA-256 为 `6ba3e9973001013cb0275985609f80c8bb55a7b546e6668f38545edbcf4d6da3`，三端实际构建摘要均为 `d7e84cd1325d0c24b451d9617fa9e531eca64da3a65b4fa87ede7901832168c0`。这是本地候选 npm 包，没有发布到 npm registry。

最新采样三端均 READY：Mac PID 49058（17/17 IM），Linux PID 228641（12/12 IM），Windows PID 12744（21/21 IM）。Windows 由原有 VOKO-Debug-Manual 计划任务启动。启动期间 status 一度显示 stopped，但随后同一 PID 持续运行并 READY；不能把先前状态查询单独作为进程崩溃的证据。

截至本轮记录，已通过 macOS Chrome 实际发送 15 个 Agent 的测试消息，问题为“请用一句中文回答：2加3等于多少？”。Mac Hermes、Linux Claude、Linux Qwen 的网页均已显示“2加3等于5。”。日志中对应 14 个 ProviderTurn 记录 generated/delivered；其余结果仍需逐个回到网页核对，不能将日志交付当作网页验收。Mac DuMate 的网页明确显示“Agent 尚未启用自动回复”，日志为 AUTOMATIC_DELIVERY_DISABLED。

当前仍未解决：Windows Qwen Office 原生命令曾返回 3221225477，且仍有状态查询超时；Windows Hermes models 探针仍出现 401；历史 PEER_NOT_FOUND/加密锁未全部恢复；两个 backend=others 注册对象的实际 Provider 尚待用户说明。启动及同步期间仍有 A2A、目录请求超时，部分有恢复日志。暂未取得将这些问题归因于本次包变更的证据。

网页交互中出现多次自动化超时。后续原生应用工具明确报告 Mac 已锁定且自动解锁失败，需要用户手动解锁；不能将这些自动化超时直接计为 VOKO 回归。未重复发送已在页面出现的测试消息，未关闭加密或改变 Agent 可见性。网页全量验收仍未完成。

## 第二批：Windows 进程查询失败必须与进程不存在区分

本次启动状态观测促成代码复核，但未保存当时 CIM 调用的退出状态，因此不能断言每次 stopped 均由此原因造成。代码缺陷和最小复现则已确认：`inspectWindowsProcess` 将超时、非零退出、无效 JSON 与成功查询但进程不存在都返回 null。`acquireInstanceLock` 会把这一 null 当作旧实例已退出并移除旧锁；停止流程也可能误报退出已确认。

修复使用既有错误传播路径：CIM 采用 ErrorAction Stop，单个及批量进程查询失败抛出固定错误码 PROCESS_INSPECTION_FAILED；成功的空结果仍表示进程不存在。status 对该错误明确输出 unknown/running=null。没有放宽 PID/创建时间匹配，没有用 PID 存活代替身份验证，也没有提高超时或加入后台轮询。权衡是查询不可用时相关操作会失败并保留锁，而非声称进程已退出。

新增故障注入测试覆盖超时、非零退出、无效 JSON 下的进程检查、退出确认、终止和旧锁保留，以及批量 worker 查询；保留成功空查询与有效身份的对照。原实现 6 项失败/2 项通过；修复后扩展为 11 项全部通过。进程生命周期组合 19 项通过、1 项平台跳过（与新增测试有重叠，不相加）。完整 release:gate:code 门禁通过：1548 项通过、2 项既有平台跳过、0 失败；类型检查、构建、i18n、覆盖率基线和源码敏感信息扫描均通过。

原始证据位于忽略目录 `artifacts/production-remediation-20260905/`；其中保存主机备份清单、当前状态、日志摘要、安装结果和候选 tarball。逐项进度在本目录 `execution.json`，状态保持 active。

## 第二批部署与 Windows 原生验证

`bddb0e1` 已部署到三端。tarball SHA-256：`50330958df125f04d6b80d3fe17529b95b2d14f8b426b52dc78e818a59811167`；三端实际构建摘要：`af21bdb17e752a94239ddb73f63e6b7b5f06391a0b0fcf1b39daa47b76cf5c6c`。最新状态 Mac PID 69054、Linux PID 230670、Windows PID 3676，均 READY，分别 17/17、12/12、21/21 IM 连接。注册清单重新对比无增删，共 50 个 Agent。

在 Windows 原生 Node 上，安装包的 11 项故障注入测试全部通过。另通过实际 `voko status --json` 进程注入 CIM 超时，验证退出码 1、PROCESS_INSPECTION_FAILED、runtimeState=unknown、running=null；故障调用前后运行实例 owner 文件摘要一致。测试仅运行只读 status，未对实际服务注入故障或修改锁。

第二次启动后的日志复核：Mac 的 A2A 警告是当前无符合发布条件的 Agent，属于目录发布条件；不能据此认定通信故障，也不应自动修改可见性。Linux 当前窗口只有启动横幅造成的空 ERR。Windows 00:27:53 仍有 Hermes models 401，须通过后续真实任务区分默认探针和实际 profile 的认证状态；00:29:29 千问办公再次记录 status_failed、exitCode=3221225477，原生异常退出仍可复现。新窗口仅几分钟，不能代替长期稳定性或全 Agent 对话验收。

此轮第二批证据在 `artifacts/production-remediation-process-20260905/`。前述 15 次网页发送、3 次可见回复属于第一批提交 fa45ecb；第二批提交的全量网页回归仍 pending。Mac 锁定阻碍网页操作，已请求用户手动解锁，未尝试绕过设备锁或索取密码。

## Provider 诊断复核与第三批安全修复

2026-09-05 07:32 UTC 对 Windows Hermes 做只读原生 HTTP 检查：当前数据库选用的 default profile 对 /health 和 /v1/models 都返回 200。LocalAppData 根 config.yaml 与其凭据一致；profiles/default/config.yaml 和 ~/.hermes/config.yaml 的旧凭据分别返回 401。因此启动时选候选配置产生的 401 不能作为当前 Hermes 整体认证失败的证据。没有修改或泄露凭据，也未把认证可用记为网页对话通过。

Windows 千问办公原生矩阵：--version 退出 0；status 在用户目录和 binary 目录均以 3221225477 退出，均无 stdout/stderr。Windows Node 架构为 arm64，所用 PE machine 为 8664（x64）。[Qoder CN CLI 官方安装文档](https://docs.qoder.cn/cli/installation) 当前明确列出 Windows arm64 暂不支持。该事实提示兼容性限制，但不证明此次崩溃的唯一根因；未替换原生程序、删除登录数据或声称通过 VOKO 延长超时能解决。证据在 artifacts/provider-diagnostics-20260905/。

对 Windows Goose 的旧回执失败进一步复核：同一 peer 下，新普通会话的路由与旧 E2EE 锁使用不同 conversation key；目录实测无 key 和带当前 key 两次都返回 PEER_NOT_FOUND。原快测源消息实际标记 securityMode=plaintext。故单纯给回执补一个新会话 key 并不能修复目录访问拒绝，反而可能绕过旧加密锁。

确认的新缺陷：对从未建立 E2EE 的本地 route，SecureOutboundRouter 原先把明确的 Directory 身份/访问拒绝当作能力未知，允许调用明文发送器。两个最小复现原实现均失败：首次拒绝仍发送、新 route 能避开旧会话拒绝。修复在明确 PEER_NOT_FOUND、E2EE_KEY_NOT_FOUND、AGENT_NOT_FOUND、E2EE_V2_AGENT_IDENTITY_UNAVAILABLE 或 HTTP 401/403 时停止发送，保留错误码。10 秒失败缓存也保留 HTTP 状态，避免 prepare 拒绝后 deliver 从缓存中丢失拒绝语义。既有身份/加密/可见性边界未放宽，未修改独立 voko-server 仓库。

定向 E2EE、运行时、回执组合 80 项全部通过。测试覆盖 prepare 与随后缓存路径的 deliver 均拒绝、旧锁保持、无明文/密文发送，以及既有恢复流程。此修复不会让服务端本来拒绝的跨主人私有 Agent 通信变成成功；那需要真实授权，不能作为代码修复擅自添加白名单或公开 Agent。

第三批安全修复的完整 release:gate:code 门禁通过：1550 项通过、2 项既有平台跳过、0 失败；覆盖率基线、类型检查、构建、i18n 与源码包扫描均通过。

随后单独修正 Qwen Office 超时诊断文案：实际 STATUS_TIMEOUT_MS 为 10000，但默认 detail 硬编码成 5000ms。改为引用实际常量，并增加输出断言。仅诊断文案变化，没有延长超时或改变 readiness；构建和相关 Provider 20 项测试通过。上述完整门禁对应安全修复，最终诊断文案另由该定向测试验证。

## 第三批部署与验收边界

安全修复 734bd17 与诊断文案修复 0f4ada3 已一起打包、备份并部署到三端；tarball SHA-256 为 `21740c804c30f910213e09eb817a2dcd182345afd101be169dc8a3829dd33e04`，三端实际构建摘要均为 `00e769d96ee4b6c4e9f0f62d93a501f1f46dbed077ddfa82efe05f1ba4fb314c`。Mac PID 88753、Linux PID 232247、Windows PID 7744 均 READY，分别 17/17、12/12、21/21 IM 连接。注册清单无增删。

Windows 安装包上的两项新增策略测试通过；结合真实目录接口，在隔离数据库中使用安装包路由器验证 prepare/deliver 均返回拒绝，rawCalls=0、seals=0，未尝试生产 IM 发送。此证据证明明确目录拒绝后的安全边界，不能代替成功对话测试。07:49:56 UTC 再查当前 Hermes profile，health/models 仍均为 200。

本次启动后仍有短暂 A2A/邮件查询网络告警，Mac A2A 设备注册提示无符合发布条件的 Agent；未据此改变可见性。Mac 在本轮继续被原生工具确认锁定，故未进行新的网页操作；未将之前可见回复替代本候选包的全量网页验收。已询问是否有兼容的 x64 Windows 主机供千问办公验证，尚无答复。此前两个 backend=others 的实际 Provider 也待用户说明。目标保持 active，不能宣称全量完成。

部署与 Windows 验证记录：artifacts/production-remediation-policy-20260905/。

## 当前阻塞状态

第三个连续目标轮次再次通过原生 CUA 工具确认 Mac 锁定，自动解锁失败。代码工作区已核对，无未提交修复；最新候选包 0f4ada3 的 50 个 Agent 网页回归均为 pending。目标工具已标记 blocked，未标记完成。需要用户手动解锁 Mac 后继续原范围的真实网页验收。两个 AUTO-REG 的实际 Provider 和千问办公兼容环境仍待说明。此前测试、部署、候选包及网页现场均保留。

## 恢复后的日志复核与网页进度

2026-09-05 12:21 UTC 完成三端最近一小时日志复核，详见 [日志复核记录](log-review-1221-utc.md)。Mac 无新增错误/告警；Linux 间歇性目录和 A2A 请求失败；Windows 千问办公原生故障与历史锁 PEER_NOT_FOUND 仍存在。未确认新包引入的新回归。另记录 ACP 正常进度被标为 ERR 的既有日志分类问题。

Mac 锁定障碍已解除，网页输入恢复；当前候选 0f4ada3 的 Linux Qwen、Goose、OpenCode 已取得实际可见正确回复和对应 generated/delivered 日志。当前进度 3/50，剩余 47 个，目标 active。此前 blocked 章节为历史状态。

## 50 个 Agent 首轮网页矩阵完成，修复目标尚未完成

2026-09-05 12:45 UTC，当前候选 0f4ada3 已通过 macOS Chrome 向三端全部 50 个 IM 身份各发送一条“7加8等于多少？”并逐项检查网页。36 个网页显示正确答案 15，14 个未通过；最新逐项状态在 execution.json 的 currentCandidateBrowserRegression。

- macOS：13/17 正确回复；Copilot 拒答；千问办公 o9hPdJ、AUTO-REG、DuMate 提示自动回复未启用。陈老师 WorkBuddy 和另一千问办公 pBp2ts 实际对话成功，不能继续把之前 readiness 快照当成当前交付失败结论。
- Linux：11/12 正确回复；Copilot 拒答。ZeroClaw 的 IM UID 经实时 list_agents 验证为 agent_cc612a3bef4fef7a，网页仍显示旧 AUTO-REG-LINUX-20260828 名称，按同一 IM 身份完成补测并取得正确回复。
- Windows：12/21 正确回复；Copilot、AUTO-REG、OpenHands、千问办公、DuMate 未启用自动回复；CodeBuddy、OpenCode、Cline 显示结果未知；WorkBuddy 显示当前无法处理。

Mac/Linux Copilot 的可见回复明确拒绝将嵌入的 security context 当作系统指令，并未回答普通算术问题；暂时归类为提示上下文兼容性问题，不得将其作为提示绕过或放宽权限的理由。

部分会话首次切回时仍显示“处理中”，再次进入并完成后台历史同步后正确回复出现。此现象仍需区分同步延迟与前端交互问题，不能依据第一次 DOM 快照断言消息丢失。本轮曾出现页面自动聚焦输入框与连续搜索竞争，已清理工具误填的搜索词草稿，未发送该草稿；后续操作需逐步核验搜索框和会话标题。

Windows CodeBuddy/OpenCode/Cline 日志均在 ACP initialize 连接等待 15000ms 后失败，未记录本次 session/prompt 调用，却由 Dispatcher 记为 outcome_unknown，阻止后备通道判断。代码复核确认 _ensureAgent 抛错位于现有 session/new 的 not_delivered 分类之外。新增 3 项边界测试，原实现 1 失败、2 通过；最小修复仅给未提交当前请求的连接失败补上 not_delivered，保留显式不确定结果，并验证 session/prompt 发出后的断连仍 outcome_unknown、仅调用一次。构建及关联路由/安全策略 62 项测试通过，完整 release:gate:code 门禁通过（1553 项通过、2 项既有平台跳过、0 失败），覆盖率基线、类型检查、构建、i18n 和源码包扫描通过。原始请求未重放，生产仍运行 0f4ada3。

## Windows Copilot 安装发现修复与 ACP 原生诊断

实时文件探针确认 Windows 的 %APPDATA%\npm 没有 @github/copilot，但当前 Node 所在的 Local\Programs\nodejs\node_modules 有 npm-loader.js。原解析器仅检查前者，导致已安装的 Copilot 被判不可用。修复继续优先既有 Roaming 安装，同时检查当前 Node 目录和标准 Local Node 目录；仍通过当前 Node 直接执行明确的 loader 文件，不启动 shell，不改变工具权限参数。

4 项路径测试原实现 2 失败/2 通过，修复后全部通过；构建和相关 Provider/权限策略测试 81 项通过。完整 release:gate:code 门禁通过：1557 项通过、2 项既有平台跳过、0 失败。Windows 原生运行新解析函数找到正确 loader，--version 退出 0、版本 1.0.80。版本探针不代表登录或完整对话通过。

使用独立进程对现有 Windows OpenCode、CodeBuddy、Cline 做 initialize-only 诊断，没有创建业务 session/prompt 或发送生产 IM：三者握手均成功，耗时分别约 13.9、11.1、11.4 秒。诊断允许最长 45 秒，但观察值均小于 15 秒；本修复未改变运行时 15 秒上限。先前业务矩阵的超时仍真实存在，当前证据只能说明不是永久无法启动，尚不能把唯一原因定为负载或首次启动耗时。
