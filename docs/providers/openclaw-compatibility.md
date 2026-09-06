# OpenClaw 版本兼容与访客权限证据

核验日期：2026-09-05。对应 [实施计划 v2](../plans/openclaw-version-compatibility-2026-09-05.md)。本页区分包/参数证据、Gateway 认证、模型执行和 IM 投递。

## 实现规则

- CLI 读取实际入口和 OpenClaw 包版本；入口/包原地更新、符号链接换目标、状态目录、配置选择和 Agent 实例进入运行身份。复用解析与 manifest 缓存；不执行每消息版本命令，不读取凭据内容生成摘要。
- Gateway 的版本与协议来自关联成功的 `connect` / `hello-ok`，不借用本机 CLI 版本。界面中的 VOKO Node 是适配器进程版本，不代表远端 Gateway 的 Node。
- 能力摘要修订为 2，排除 `observedAt`、`expiresAt`。仅重新检测不会制造保存冲突；身份/控制语义变化仍会改变摘要。升级前产生的未提交 preflight 应重新获取；现有已保存的补充提示语不迁移。
- 固定包 `2026.6.1`、`2026.7.1-2`、`2026.9.2` 保留 `agent --agent --session-key --message --local --json`。未知版本（包括预发布版）先以有界 `agent --help` 检查必需参数，按运行身份缓存成功结果；检查不包含访客内容。参数存在只允许进入兼容调用，不证明执行结果或权限边界。
- 实例发现、注册页面和工作区元数据读取兼容旧 `agents.list` 与新版 `agents.entries`，只做读取归一化，不改写原生配置。
- 同一真实状态目录中的 VOKO CLI 调用排队执行，包括不同 Agent；等待上限 120 秒，停止 Provider 可取消等待任务。隔离调用方已超时/退出时，提交前再次校验，禁止过期任务在排队结束后启动。已启动的任务仍受原 CLI 120 秒执行期限控制，停止不宣称已经撤销其副作用。独立状态目录互不阻塞。跨进程竞争交给 OpenClaw 自身的锁，VOKO 不删除锁、不关闭主人 Gateway。
- push 与 steer 共用退出码/回复判定；非零退出或无有效回复不发送成功回复。进程启动后的失败保持 `outcome_unknown`，不因 stderr 看起来像“未执行”就重投。只有执行前拒绝/排队取消等有证据的情况是 `not_delivered`。
- WS 按协议/功能协商，保留 v4→v3 mismatch 降级及 chat/session.message 路径。挑战时间必须为正的安全整数；关联 connect ID、hello 类型和协商协议后才认证。任意成功响应、畸形挑战均不能认证。
- WS push 的 `executionState: pending` 表示已提交；关联 chat 回执可以标记 ACCEPTED，关联 final 才标记 COMPLETED。错误/中止标记 FAILED，断线/截止时间记录 OUTCOME_UNKNOWN。重复或冲突的 runId 不结束另一回合。结果未知不触发自动重投；晚到消息仍遵守现有会话与投递保护。
- 本地 Gateway 自动配置只在用户发起该配置流程时补 `gateway.mode=local`，保留已有字符串 Token。写前备份；无法解析配置时停止，不覆盖为新配置。远程模式、password、SecretRef 等认证明确报不支持此自动配置路径。自动拉起不使用 `--force` 抢占端口。
- Gateway 冷启动捕获有界 stderr，状态中的 `startupFailure` 提供退出码和脱敏摘要；进程在 ready 前退出会及时结束等待。仅当 VOKO 自己启动的进程明确报告插件迁移收敛后要求重启时，自动重启一次，两次尝试共用原有 90 秒启动预算；并发调用共用该启动过程。重复迁移失败、缺少必需凭据或配置错误直接失败，不无限重试。存活但缓慢启动的进程沿用已有等待机制，不额外启动第二个进程。停止 Provider 会取消恢复。


## 版本与环境矩阵

`test/fixtures/openclaw-compatibility/contracts.json` 记录固定包来源、完整性及源码 SHA-256。其消息样本由包内 schema/处理代码构造，明确标为**源码契约 fixture**，不是捕获到的模型回复。真实探测另行记录。

| 版本 | macOS ARM64 CLI 参数 | Gateway 握手 | 模型两轮/附件/IM 投递 | 原生权限 canary |
| --- | --- | --- | --- | --- |
| 2026.6.1 | 隔离安装依赖，真实 `agent --help` 通过 | 隔离真实认证通过，v4 | 本轮未测 | 未接入 |
| 2026.7.1-2 | 隔离安装依赖，真实 `agent --help` 通过 | 隔离真实认证通过，v4 | 本轮未测 | 未接入 |
| 2026.9.2 | 当前安装，隔离 HOME 的真实 `agent --help` 通过 | 隔离真实认证通过，v4 | 本轮未测 | 未接入 |
| 未知/预发布 | 只读参数检查通过后允许兼容调用 | 已知协议成功协商后允许兼容调用 | 不继承已验收标记 | 不继承原生权限证据 |
| Ubuntu 2026.7.1-2 | SSH 已连通；CLI 参数通过 | 缺少测试入口的 DeepSeek 凭据，启动被拒绝 | 凭据阻塞 | 未接入 |
| Windows 2026.7.1-2 | SSH 已连通；CLI 参数通过 | v4 认证通过 | CLI/WS 真实首轮和原生会话恢复通过；附件/IM 未测 | 未接入 |

最初 macOS 版本锚点探测使用 Node v26.7.0；后续三系统真机测试的 macOS/Ubuntu 为 v26.7.0，Windows 为 v22.23.2。旧包独立安装在临时目录，禁用 npm 安装脚本；不替换当前全局安装。依赖不是上游发布时的 lockfile 快照，故不能外推完整旧环境。此前 Windows 2026.6.1 的记录是历史证据，不算本轮复测。协议 v3 保留既有合成回归，不声称三个 v4 锚点证明所有 v3 发行版。

状态目录选择遵循 `OPENCLAW_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 和默认/旧 `.clawdbot` 目录；本批没有新增 CLI `--profile` 选择器。使用特殊 profile 时，应向 VOKO 显式传入实际状态目录与配置路径。

## 本轮验证记录

- 完整 `npm run test:ci` 通过：类型检查、构建、i18n、1611 项测试（1609 通过、2 跳过、0 失败）及全部既有覆盖率门槛。两项跳过分别是 Windows DACL 与 Linux process-owned rollout 测试，在本次 macOS 运行中不适用。
- OpenClaw 专项与 Web 页面追加回归通过，覆盖未知/预发布、包/链接变化、摘要、队列取消/超时、失败 steer、握手关联、chat 终态、重复/错误事件、断线、配置保护与无效权限不展示。
- 三个版本分别启动临时 loopback Gateway，用本次修改后的 VOKO WS Provider 完成真实挑战签名/认证。均取得对应发行版本、协议 v4、`chat.send` 与 `sessions.messages.subscribe`。CLI 9.2 与 Gateway 6.1/7.1-2 的版本识别保持独立。
- 脱敏实测记录在 `test/fixtures/openclaw-compatibility/runtime-probes.json`；只保存相关字段和帮助输出摘要，没有认证秘密、访客内容或完整配置。测试 Gateway 已停止，临时认证配置已清理。主人 Gateway/全局安装未改动。
- 最初版本锚点探测未调用模型。后续三系统真机测试中，macOS 2026.9.2、Windows 2026.7.1-2 的 CLI/WS 真实模型两轮与原生会话恢复通过；Ubuntu 2026.7.1-2 因测试入口凭据缺失被阻塞。附件访问、IM 回执和原生权限 canary 仍未验证。

## 访客安全与权限：B 线调查裁决

“OpenClaw 本身没有权限控制”是不正确的。固定版本的包内文档与实现提供原生机制，但目前 VOKO 的 CLI/WS 调用没有把以下配置绑定为不可变的逐回合权限，也不能确认目标配置由 VOKO 独占管理。因此本批保留 `additionalPrompt`，**不开放新的权限开关**。

| 控制 | 上游机制/作用域 | 本批不开放的原因 |
| --- | --- | --- |
| Shell/工具访问 | `tools.allow/deny`、Agent 工具策略 | 作用于原生 Agent/共享配置；现有调用没有携带独立工具策略，须先确认所有权、工具别名/插件覆盖及降级等价 |
| 文件与工作区 | sandbox `workspaceAccess`、容器挂载与工具策略 | 依赖真实 sandbox 后端、挂载、elevated/host 路径；提示词或只读工具清单不能证明全路径隔离 |
| 浏览器与网络 | browser 工具限制、sandbox 网络与运行目标 | 禁用一个工具不能证明插件/exec 的网络访问被禁止；需要受控端点的允许/拒绝 canary |
| 插件与 MCP | 插件启用、工具注册、MCP 服务配置 | 原生配置可能影响同一 Agent 的其他渠道；未建立隔离配置及本轮生效证明 |
| 命令审批 | `tools.exec` 与执行主机 approvals（取更严格策略） | 与执行主机、Agent、session 和审批状态相关，当前 WS 不代理该审批协议，不能伪装成 VOKO 的审批开关 |
| 新版 operator role/sandbox | Gateway named operator role 与 required sandbox | 属于版本/认证角色特定能力；当前 VOKO 使用 operator 连接，不自动创建角色或改主人认证配置 |

主要证据为固定包 `docs/tools/multi-agent-sandbox-tools.md`、`docs/gateway/sandbox-vs-tool-policy-vs-elevated.md`、`docs/tools/exec-approvals.md`、`docs/tools/index.md` 与 chat.send schema。旧 `agents.list` 与新版 `agents.entries` 的读取已兼容；权限配置写入仍不能用同一模板覆盖。

下一项原生控制只有在明确 VOKO 管理的目标实例、配置作用域、原生执行证据和安全降级之后才进入实现。届时按实际需要补充会话/在途保护；本批不进行 binding 表迁移，不创建通用权限比较引擎。

## 诊断与回滚

- `OPENCLAW_CLI_CONTRACT_UNVERIFIED`：必要 CLI 参数不能只读确认，任务尚未提交。
- `OPENCLAW_LOCAL_QUEUE_TIMEOUT/CANCELLED`：本地等待任务未执行。
- `OPENCLAW_REMOTE_SETUP_UNSUPPORTED` / `OPENCLAW_AUTH_SETUP_UNSUPPORTED`：保留现有配置，使用已支持连接方式或单独接入该认证机制。
- CLI 锁竞争沿用现有脱敏 CLI 诊断。退出码、Provider 执行终态与 VOKO 投递结果应分开查看。
- 回滚 VOKO 不会降级 OpenClaw 状态存储；也不能把旧 VOKO 的握手、摘要和异步终态问题视为已经修复。配置备份只由显式 setup 流程生成，生产 Gateway 安装、重启、发布均不属于本批交付。
