# VOKO 整体代码审查：范围与历史发现台账

状态：审查记录；产品代码尚未修改；此文件不代表修复方案已获批准。

## 基线与产品意图

- 审查仓库：`open_voko`，npm 包 `@voko/lite`，版本 `0.5.2`。
- 起始提交：`a6e8f35`（Merge pull request #58 from laoyudashu/codex/npm-update-source）；开始时工作区干净。
- 依据：根目录 README、SECURITY、CONTRIBUTING、package.json，docs/README.md、docs/testing.md，以及当前源码和测试。
- 产品目标：连接本地 Provider 与人、其他 Agent、传统系统的通信运行时。核心价值是可信身份、精确会话路由、权限控制、消息安全、Provider 执行与可靠回复。
- 对外入口：IM、A2A Gateway、REST/Webhook；本地入口：Web、CLI、MCP。私聊 E2EE 与群聊/A2A/REST 的 TLS 边界不可混淆。
- 本次“整体”指该仓库的主要子系统和跨模块路径；不等于逐行形式化验证、密码学认证或生产渗透测试。独立的 `voko-server`、`voko-chatroom`、运营服务和第三方 Provider 源码不在本轮覆盖范围。

## 审查流程与证据规则

1. 首轮 AI 审查专家独立阅读项目意图和实现，核验历史线索并寻找其他问题。
2. 另一位 AI 专家对首轮发现和历史台账做对抗复核，主动寻找反例、上游约束、测试偏差和方案设计过度。
3. 主代理综合裁决：确认 / 条件成立 / 证据不足 / 不成立 / 合并；只有证据充分且范围明确的事项进入默认执行计划。
4. 用户批准综合计划后，才开始产品修复。记录报告不构成批准。

证据分别标明：源码检查、安全内存复现、组件测试、真实环境验证。历史会话中的临时复现不是仓库内已提交回归测试；不得把复现次数等同于测试套件通过率。所有凭据均使用合成数据，文件删除使用替身或隔离临时目录。

## 两轮历史发现

下面完整保留此前会话中的问题线索和建议。优先级与成立性均是“待独立复核”的历史判断，不自动成为最终结论。H 编号用于和专家报告及最终计划交叉追踪。

| ID | 历史问题 / 触发条件 | 主要源码定位 | 历史证据与限制 | 初步最小修复方向 |
| --- | --- | --- | --- | --- |
| H01 | OpenClaw WebSocket 发出请求后即清理临时附件，Provider 可能还未读取 | `src/core/dispatcher/providers/openclaw-ws.ts`，send/sendToSession/cleanup | 源码及替身顺序复现；未证明所有实际 OpenClaw 版本均受影响 | 将附件寿命绑定完成/取消确认；异常结果明确处理，避免无限保留 |
| H02 | 本地 WebSocket 仅检查 Origin，缺少客户端认证，原生客户端可省略 Origin | 本地 WebSocket server 与事件广播入口 | 本机进程边界；不是匿名公网漏洞；需考虑同一 OS 用户本身能访问数据的信任模型 | 复用本地 Web 会话/实例认证；明确同源与身份是两种检查 |
| H03 | CLI 用整段 stdout/stderr 中的 401 等文本将失败归类为 not_delivered，可能在部分执行后 fallback | `src/core/adapters/cli-spawner.ts:62`、Dispatcher fallback | 源码及分类替身复现；需核查各 Provider 可证明的执行阶段 | 有启动/协议证据才判未投递；不确定执行结果不自动重试 |
| H04 | coalescer.flushAll 只等待 pending；Dispatcher.stop 不完整等待队列；缺少总量背压 | `src/core/inbound-turn-coalescer.ts:132`、`src/core/dispatcher/index.ts` | 停机排空与容量上限应分开复核；不是每次停机都会丢消息 | 先阻止新入队，再有界等待已接收工作；背压单列，不扩建通用任务系统 |
| H05 | 附件读写/摘要、日志同步 I/O 和部分 E2EE 整体缓冲占用主线程 | attachment、audit/runtime logger、E2EE 实现 | 源码性能风险；缺少真实负载基准，不能声称已测吞吐瓶颈 | 先测事件循环延迟和峰值内存，再局部异步/限额；不重写密码协议 |
| H06 | 会话列表对每个私聊追加查询，最坏约 3N+2；OFFSET 与索引可能放大成本 | `src/mcp/tools.ts:2246` 的 list_conversations | 查询数量可证，收益需 EXPLAIN/代表性数据验证；群聊/已回复数量影响查询数 | 批量查询/必要索引，保持可见消息与未回复语义 |
| H07 | HTTP MCP 把合法 id=0 当作 notification；访问 SDK 私有 _requestHandlers | `src/mcp/transport/http.ts:33`、`src/mcp/server.ts` | 前者为协议缺陷；后者是兼容性风险，应分项处理 | 严格区分缺失 id 与 0；先补契约测试，再决定是否替换私有访问 |
| H08 | 主人回复“不同意”被 /同意/ 匹配并加入白名单 | `src/core/access-control-api.js:151` | 真实函数 + SQLite 内存复现批准及通知分支 | 明确批准动作，含糊/否定回复不得授权 |
| H09 | owner 切换后旧 Web 会话继续有效；归属检查使用全局 owner 而非会话 owner | `src/core/local-web-session.js:48`、`src/core/owner-switch.ts:85`、`src/web/index.js:723` | 真实内存会话/切换 + 抽取源码中间件复现；未对运行服务操作 | 会话绑定当前 owner；切换撤销；统一请求身份 |
| H10 | 名单删除校验参数 agentId，却按任意记录 id 删除其他 owner 的条目 | `src/mcp/tools.ts:3507`、`src/core/access-control-api.js:95` | 实际 handler/包装器 + SQLite 内存复现；需要工具调用能力和目标记录 ID | 从资源反查归属，核对 agentId/listType，限定删除条件 |
| H11 | A2A 任务 ID 为 . 或 .. 时目录拼接越界，prepare 尝试递归删除根/父目录 | `src/a2a/attachment-workspace.ts:70`、`src/a2a/envelope.ts` | 临时密钥签名 + 模拟 fs 复现；未证明外部用户能控制网关签发 ID，未真实删除 | 严格 ID 与路径包含关系校验；删除前拒绝根及父目录 |
| H12 | E2EE 临时失败留下序号缺口，后续 MAX(message_seq) 越过检查点 | `src/core/offline-sync.ts:189` | 内存复现：101 失败、102 保存，下一次从103请求 | 明确连续处理游标；缺口保留重试，不能用最大已存消息替代 |
| H13 | 写队列吞异常，离线事务回滚后仍向 Provider 转发已收集消息 | `src/core/database.ts:619`、`src/core/offline-sync.ts:319` | 实际队列函数 + 内存 SQLite + 提交故障注入；回滚后仍调用转发替身 | 独立操作 Promise 传播错误；提交成功才产生外部副作用 |
| H14 | 正则防护不完整，规则在长度上限检查之前运行，可造成主线程高回溯 | `src/core/audit.js:95` | 隔离 VM 内 501 字节输入超过100ms预算；先决条件是已配置相关规则 | 先限长度，再受约束匹配；不能靠 Promise.race 中止同步 regex |
| H15 | 凭据模式只取首次匹配；示例占位符遮住后续非占位符匹配 | `src/core/audit.js:53` | 合成凭据格式复现；未使用真实凭据；其他规则可能偶然补救 | 遍历每个模式的全部匹配，占位符例外限于当前匹配 |
| H16 | 离线同步每频道只拉一次 limit100，不继续分页 | `src/core/offline-sync.ts:199`、协调器 | 150 条合成积压只处理100；后续重连可能补拉，非必然永久丢失 | 有界分页、调度续拉、保留可恢复进度 |

此前还提出过模块职责集中、留存策略、文档漂移等建议；这些属于审查方向，不视为已确认漏洞。必须先有当前证据、测量或明确契约差异，才安排改动。

## 已存在的工程基础

- 已有 Node 单元/组件测试分层、SQLite/网络隔离约定、Playwright、Rust E2EE 测试、覆盖率基线。
- 已有三 OS CI、CodeQL、Gitleaks、依赖审查、SBOM、包构建与发布门禁。
- 覆盖率目标与基线不同是当前明确策略，不应直接认定为绕过测试。
- 测试和安全工具的存在不能证明本轮列出的路径已被覆盖；也不应再引入一套重复平台。

## 后续执行约束

- 先最小失败用例，再最小根因修复，然后定向验证与必要的整体门禁。
- 未经批准不启动修复；批准后在独立 `codex/` 分支/工作树执行，保护当前用户修改。
- 默认计划不包含修改独立云端/Chatroom 仓库、真实用户数据库、运行服务、生产部署、公开漏洞披露、推送、合并、标签或 npm 发布。
- 新增依赖、公开协议变化、持久化模型迁移、数据清理和无法确认的副作用必须作为明确设计决策进入批准范围，不能在执行时偷偷扩展。
- 暂停条件必须具体：失败不能靠跳过检查、弱化安全行为或重复重试不确定执行来解决。
