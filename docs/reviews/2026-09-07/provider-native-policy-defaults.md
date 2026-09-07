# Provider 原生策略：默认值、用户选择与生效验证

日期：2026-09-07。范围：34 个传输定义；macOS、Ubuntu、Windows 当前已安装运行时。未提交、未部署。

原则：有可映射的原生能力时默认收紧；用户已保存的选择优先；没有能力的传输不新增禁用策略。原生模式只撤销本传输追加的限制，不等于自动批准所有工具请求。

## 本轮补齐

| 传输 | 默认值/限制 | 用户选择如何生效 |
|---|---|---|
| Hermes CLI | safe 工具集、safe-mode、不自动接受 hooks | 按既有独立开关恢复 Profile 工具、关闭 safe-mode、选择审批和 hooks |
| Goose CLI | no-profile | 原生扩展配置模式移除 no-profile |
| Claude CLI | 空工具、plan、隔离配置、禁用 Chrome | 工具、权限模式、配置加载与 Chrome 独立映射；不再固定覆盖 plan |
| Codex CLI | read-only | 可选 workspace-write，或不追加 sandbox 使用原生配置；沙箱探针失败时只开放明确的原生选项，不自动改设置 |
| Qwen CLI | safe-mode、plan、排除工具、零工具预算 | 原生模式移除这些参数和 VOKO 的 safe-mode 环境覆盖 |
| Pi CLI | no-tools/no-extensions/no-skills | 原生模式移除上述限制 |
| Reasonix CLI | dontAsk | 原生模式不覆盖权限模式 |
| Grok CLI | plan、拒绝工具、禁用 Web/子 Agent/记忆 | 原生模式移除本传输追加的对应限制 |
| Aider CLI | ask、dry-run、禁用 URL 检测和 Shell 建议 | 原生模式恢复对应原生设置；Git 自动提交仍禁用 |
| Cline CLI | plan、关闭自动审批、命令拒绝环境配置 | 原生模式撤销这些覆盖 |
| Cursor CLI | plan | 原生模式不追加执行模式，不添加 force/yolo |
| Gemini CLI | plan、既有 Docker 沙箱 | 默认不受旧 yolo rollout 影响；原生模式不覆盖审批或沙箱环境，不要求 VOKO Docker 沙箱可用 |
| Kiro CLI | 空 trust-tools | 默认不自动信任工具；原生模式使用 Agent 自身信任配置 |
| Copilot CLI / ACP | 拒绝 read/write/shell/url，隔离定制指令、内置 MCP | 原生模式撤销对应启动限制；不添加 allow-all；ACP 审批回调仍拒绝 |
| CodeBuddy ACP | dontAsk、空工具、严格 MCP | 原生模式撤销启动覆盖；ACP 审批回调仍拒绝 |
| Trae CLI ACP | plan、禁止 Bash/Edit/Write | 原生模式撤销启动限制；ACP 审批回调仍拒绝 |
| OpenCode CLI / ACP | 工具 deny、隔离插件；CLI 不自动审批 | 工具权限、插件、CLI 自动审批独立控制；同时处理 argv 和环境变量，不遗留 deny-all 覆盖 |
| WorkBuddy HTTP | 空工具、dontAsk、既有会话/MCP 默认 | 保留 read_write、bypassPermissions 等用户已保存值；支持原生工具与默认审批；进程重启应用 |
| QwenWork CLI、DuMate HTTP | 既有可验证会话/权限控制 | 纳入配置保存、重载、回合与实测矩阵；不扩展未经证实的工具开关 |
| 其他传输 | 保留已有边界和能力提示 | 不从同一 Provider 的 CLI 推断 HTTP/ACP 支持；不新增强制禁用 |

完整逐传输、逐主机版本和结果见 [验证报告](provider-native-policy-validation.md) 与 [机器可读矩阵](provider-native-policy-matrix.json)。

## 根因修复

1. 配置曾只影响界面/部分参数：统一处理最终 argv、VOKO 注入的环境和提示语；用户原生环境保持继承。
2. WorkBuddy 读取历史配置时曾把放宽值重写为收紧值：删除强制迁移，保留明确选择。
3. 持久 ACP 进程不能只更新数据库：沿用现有 Agent 运行时重启路径，验证新进程收到新配置。
4. 能力展示曾复用旧验证结果：使用最新观测，仅同指纹且明确 stale_verified 时复用；展示支持的值，不因打开页面自动选中原生模式。
5. 版本与诊断可能失真：DSH 读取实际包版本并通过 Node 启动；可执行文件变化使版本缓存失效；放宽后不再宣称默认限制仍生效。

## 验证范围与限制

- 34 个传输的可编辑值逐一经过保存、服务重载和新访客回合；11 个 CLI 用真实无害子进程核验 argv/env/prompt；4 个 ACP 核验启动和配置变更后重启。
- 同包矩阵在三系统各 53 项通过。它证明配置传播和生命周期，不替代原生模型工具执行验证。
- 原生实测使用新合成 Agent/会话、随机文件标记及本机 HTTP canary，不发送真实 IM，不修改生产 Agent 配置。
- 静态兼容规则仅覆盖本轮实际观测版本和 arm64 宿主 Node 环境；未覆盖版本/架构不宣称已验证。此架构字段不等于逐个二进制架构鉴定。
- OpenCode attach / 共享 ACP 服务没有新增每 Agent 的全局权限修改。ZeroClaw 原生 Agent 配置保留既有共享 Profile 保护；本轮不修改真实 Profile 做放宽实验。
- Pull-only 外部消费者没有受控执行传输，未做其 Agent 内部工具验证；浏览器、MCP、附件和跨会话攻击也不是本轮实测完成项。
