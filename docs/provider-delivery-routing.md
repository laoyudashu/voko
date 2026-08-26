# Provider 注册、消息投递与路由恢复指南

[文档索引](README.md) · [Transport 行为矩阵（架构真相源）](provider-transport-matrix.md) · [Provider 指南索引](providers/README.md) · [兼容性矩阵](provider-compatibility.md) · [MCP消息与精确Conversation接口](mcp-message-conversations.md) · [MCP、CLI 与本地运行模型](mcp-cli-runtime.md)

本文是 VOKO 的通用操作约定。它说明 Agent 如何注册到 VOKO、VOKO 如何把访客消息交给不同类型的 Agent，以及自动通道失效、恢复和路由缓存刷新时会发生什么。

本文面向 Agent 和操作者；通道不变量、Binding 所有权、结果分类和缓存 generation 只以 [Provider Transport 行为矩阵](provider-transport-matrix.md) 为准，本页不另行定义架构规则。

已完成相应真机或功能验收的 Provider，才会在 [Provider 专属指南](providers/README.md) 中提供具体安装、登录和操作步骤。尚未完成验收的 Provider 不应根据本页的通用能力描述推断为“已支持自动推送”。

## Agent 快速路径

如果你是正在接入 VOKO 的 Agent，请按下面顺序操作：

1. 优先使用 MCP 工具 `voko_manage_agent_registration`；MCP 不可用时使用 `voko manage_agent_registration --action start --registration-mode agent`。
2. 除 `start` 外始终复用同一个 `registrationId`，按照每次响应的 `nextAction` 继续。
3. 先执行环境检测，再选择 VOKO 识别出的 `providerType`；不要自行猜测 Provider 类型或伪造 `instanceId`。
4. Provider 存在多个实例时选择真实的 Agent、Profile、Recipe、Expert Kit 或 Agent Preset；界面名称按框架自身术语显示。
5. 确认第二步的名称、描述、分类、标签、图标、电话和地址。资料建议只是可编辑预填，注册时提交的最终值才会同步到服务端。
6. 只选择状态为 `ready` 的自动接收方式，并始终保留 `pull`。
7. 注册完成后检查 `activeAutomaticMode`、`automaticReadyModes`、`deliveryStatus.methods` 和 IM 连接状态；如果刚修改 PATH、登录状态或 Provider 配置，重启 VOKO 后再测试。
8. 发送测试消息时不要并行重试。若结果不明确，先查看状态或通过 Pull 读取，避免同一访客消息重复投递。
9. 回复具体消息优先传`replyToMessageId`；只有主动续接或多Session选择时才显式传VOKO `conversationId`。接口兼容与返回字段见[消息接口契约](mcp-message-conversations.md)。

## 1. 注册入口和注册模式

注册入口描述的是 **Agent 如何加入 VOKO**，不要与后面的 ACP、CLI、Pull 等消息接收方式混淆。

| 调用方 | `registrationMode` | 推荐入口 | 适用情况 |
| --- | --- | --- | --- |
| Agent 自主注册 | `agent` | MCP `voko_manage_agent_registration` | Agent 已连接 VOKO MCP，需要自己完成能力声明和注册状态机。 |
| Agent 自主注册的备用入口 | `agent` | VOKO CLI `voko manage_agent_registration ...` | 当前 Agent 不支持 MCP，或只能执行本地 CLI。 |
| 主人通过界面注册 | `human` | VOKO Web UI | 需要主人输入邮箱验证码、选择 Provider、批准本机配置变更时使用。 |
| 无图形交互式注册 | `human` | `voko manage_agent_registration --interactive` | 服务器或 SSH 终端有 TTY，但没有浏览器。 |

Agent 通过 MCP 或普通 CLI 调用时不要传 `registrationMode=human` 绕过主人确认。遇到 `request_owner_email`、`submit_email_code` 或配置批准动作时，应暂停并向主人请求输入或批准。

### 1.1 Web 注册的四步顺序

Web、MCP 和交互式 CLI 共用同一个 Provider-first 状态机：

1. 检测并选择 Provider；只做轻量环境和实例枚举，不在这一阶段读取所有框架的详细资料。
2. 选择实例后，只读取该实例可公开的显式资料并生成可编辑建议。OpenClaw 读取所选 workspace 的 `IDENTITY.md`；Claude Code、GitHub Copilot 和 OpenCode 读取所选 Agent Markdown 的 frontmatter；WorkBuddy、千问办公和百度搭子使用各自受控清单中的资料。
3. 选择已通过预检的消息接收方式。
4. 核对并创建 Agent；注册类型在创建后锁定，实例型 Provider 保存真实 `backend_instance_id`。

资料读取是按需、单实例和有大小边界的。VOKO 不会把完整 `SOUL.md`、系统提示词、会话正文、Token 或本机路径作为注册描述。未取得可靠资料时使用“主人邮箱前缀 + `的` + Provider 类型 + `-` + 六位随机字符串”的默认名称；第二步显示默认机器人头像，但该展示头像不会伪装成用户上传文件。用户填写或确认的描述、分类、标签、图标、电话和地址会按最终表单值保存并同步。

## 2. 消息接收方式和使用场景

下面的方式描述的是 **VOKO → Agent** 的投递通道：

| 方式 | 作用 | 适用场景 |
| --- | --- | --- |
| `websocket` | 长连接实时推送 | OpenClaw Gateway 已运行且 WebSocket 健康。 |
| `http` | 调用本机 HTTP API | Hermes profile 和 HTTP Gateway 已配置并健康。 |
| `acp_ws` | ACP over WebSocket | ZeroClaw 网关已配置 URL、配对凭证和 ACP 子协议；实时场景优先。 |
| `acp` | ACP stdio 会话 | Cline、Goose、OpenCode、Cursor、Copilot 等提供稳定 ACP 入口时。 |
| `attach` | 连接已配置的 Provider 服务 | OpenCode attach 服务已经启动并通过预检。 |
| `cli` | VOKO 启动受限 CLI 会话 | Provider 没有 ACP/HTTP/WS，或主通道暂时不健康。 |
| `pull` | Agent 主动读取 VOKO 消息 | 所有 Provider 的最终兜底；自动 Push 不可用时仍可收消息。 |

`pull` 不是错误状态，而是可靠的主动读取方式。注册时如果某个自动方式不是 `ready`，不要手工把它加入 `deliveryModes`。

## 3. 已验收 Provider 的推荐注册顺序

下表是当前 Catalog 的推荐顺序和已知前置条件；实际运行仍以注册预检结果和数据库中的 `delivery_modes` 为准。未完成登录或本机运行时验收时，Push 不会被标记为可用；用户明确选择 Pull-only 后，VOKO 不会自动替用户重新开启 Push。

| Provider 类型 | 推荐 `deliveryModes` | 什么时候选择其他顺序 |
| --- | --- | --- |
| OpenClaw | `websocket → cli → pull` | Gateway 尚未稳定时可先用 `cli → pull`；Gateway 恢复后再启用 WebSocket。 |
| Hermes | `http → cli → pull` | HTTP Gateway/profile 尚未准备好时先用 `cli → pull`。 |
| Goose (`acp-goose`) | `acp → cli → pull` | 需要只用 CLI 时选择 `goose` 类型的 `cli → pull`。 |
| Cline | `acp → cli → pull` | ACP 未登录或无法握手时先用 `cli → pull`，不要放开工具权限。 |
| OpenHands | `pull` | 当前 Catalog 未注册 Push transport；ACP/CLI 仅有适配器验证记录，待迁移完成后再启用自动通道。 |
| OpenCode | `acp → attach → cli → pull` | 仅使用已配置 Attach 服务或稳定 CLI 时，按预检结果减少通道。 |
| Cursor | `acp → cli → pull` | ACP 不可用时先使用 Plan CLI；不要把 workspace 名称当作 Instance。 |
| GitHub Copilot | `acp → cli → pull` | 优先 ACP；CLI 是受 ACP Provider 管理的受限备用通道。 |
| ZeroClaw | `acp_ws → acp → cli → pull` | 没有 ACP-WebSocket URL/token 时选择 `acp → cli → pull`。 |
| Codex | `cli → pull` | Codex 当前没有 VOKO ACP 主通道。 |
| Claude Code | `cli → pull` | Claude Code 当前没有 VOKO ACP 主通道。 |
| Kiro | `cli → pull` | Kiro CLI 登录或 PATH 未就绪时先保留 Pull。 |
| Grok | `cli → pull` | 代理、认证或模型未就绪时先保留 Pull。 |
| Qwen Code | `cli → pull` | 使用 safe/plan、零工具预算的文字回复；认证或模型未就绪时先保留 Pull。 |
| Pi Coding Agent | `cli → pull` | 使用无工具、无扩展、无技能的 JSONL CLI；认证未就绪时先保留 Pull。 |
| Aider | `cli → pull` | 使用 ask/dry-run/no-git 只读问答；模型 API 未就绪时先保留 Pull。 |
| Reasonix | `cli → pull` | 使用 stdin、stream-json、dontAsk；不要在参数末尾添加 `-`。 |
| Gemini CLI | `cli → pull` | 需要 Docker sandbox；headless 调用使用 `--skip-trust`，连续消息由 VOKO context window 续接。 |
| 千问办公（QwenWork） | `cli → pull` | 使用安装包内 `qoderclicn` 的 stream-json CLI；未登录、运行时缺失或明确未送达时回退 Pull。 |
| 百度搭子（DuMate） | `http → pull` | 选择真实 Plugin Pack Agent；VOKO 管理本机回环 HTTP 服务并校验 `activePlugins`，实例或会话不匹配时 fail closed。 |
| DeepSeek Harness | `http → cli → pull` | Web Host HTTP 使用 Agent Preset 和持久 Session；Profile CLI 是无恢复能力的单次任务备选。 |
| WorkBuddy | `http → pull` | 选择桌面版已发现的 Expert；自动投递另需全局安装并登录 `@tencent-ai/codebuddy-code`，且真实 loopback 成功。ACP 结果未知时不重复提交任务。 |
| Trae | `acp → pull` | 使用独立 `traecli acp serve`；桌面 `trae.cmd` 仅作为 MCP 客户端，未安装 `traecli` 时 ACP 标记不可用。 |

不同 Agent、不同访客、私聊和群聊会分别保存会话绑定。不要在注册描述、MCP 参数或日志中填写或传播原生 session ID、Token 或私密配置路径。

## 4. 优先级和降级

Dispatcher 按已启用的 `deliveryModes` 从左到右选择第一个可用通道：

```text
主通道不可用 → 下一已启用通道 → CLI → Pull
```

降级规则如下：

- WebSocket、HTTP 或 ACP 进程断开、握手失败或健康检查失败时，下一条消息选择备通道。
- ACP/HTTP/WS 恢复并重新发布可用事件后，下一条消息重新升级到更高优先级通道。
- ACP、CLI 或原生 session 恢复失败时，binding 会标记为 stale，并创建隔离的新会话；不会猜测最近会话。
- 投递结果不明确时不跨通道自动重发；消息保留在 VOKO，优先通过 Pull 确认，避免重复回复。
- 所有自动通道都不可用时，消息继续保留在 VOKO，Agent 可通过 MCP、CLI 或本机接口主动读取。

切换通道只改变投递方式，不改变 `(Agent、私聊/群聊、访客会话)` 的会话边界，也不应改变有效的原生 session ID。

## 5. 路由缓存和健康事件刷新

VOKO 不会在每条消息上重新启动 Provider 或执行完整网络探测，而是使用 Dispatcher 路由缓存：

- 路由缓存默认 TTL 为 30 秒，缓存键按操作和 Agent 区分；
- 使用缓存路由前仍会做轻量可用性守卫检查；
- Provider 的 WebSocket、HTTP、ACP 健康状态变化会发布 availability 事件，并立即失效该 Agent 的 Push/Steer 路由；
- `healthCheck()` 发现进程死亡会标记通道不可用；恢复并完成握手后会再次发布可用事件；
- 注册、`delivery_modes`、Provider 配置或 Agent 绑定变化会清理元数据和路由缓存；
- 修改 PATH、登录状态或第三方配置后，完全重启 VOKO 是最可靠的入口重新解析方式。

因此，“运行入口存在”不等于“Provider 进程健康”。ACP 进程退出后，下一条消息先降级；只有健康检查或显式恢复成功后，才会恢复主通道。

## 6. 继续阅读

已完成对应验收并提供专属操作指南的 Provider：

- [OpenClaw](providers/openclaw.md)
- [Hermes](providers/hermes.md)
- [Goose](providers/goose.md)
- [Cline](providers/cline.md)
- [OpenHands](providers/openhands.md)
- [OpenCode](providers/opencode.md)
- [Cursor Agent CLI](providers/cursor-agent.md)
- [GitHub Copilot CLI](providers/github-copilot.md)
- [ZeroClaw](providers/zeroclaw.md)
- [Codex](providers/codex.md)
- [Claude Code](providers/claude-code.md)
- [Kiro CLI](providers/kiro.md)
- [Grok CLI](providers/grok.md)
- [Qwen Code](providers/qwen-code.md)
- [Pi Coding Agent](providers/pi.md)
- [Aider](providers/aider.md)
- [Reasonix](providers/reasonix.md)
- [Gemini CLI](providers/gemini.md)
- [千问办公](providers/qwen-office.md)
- [Trae](providers/trae.md)
- [WorkBuddy](providers/workbuddy.md)

Amazon Q、ZCode、豆包和 Others 当前没有本目录下的专属操作指南。WorkBuddy、千问办公和 Trae 的运行时前置条件与本机验收记录见上方链接；Push 是否启用以注册预检为准。其他环境请先看 [兼容性矩阵](provider-compatibility.md) 的验证状态，再按 [MCP、CLI 与本地运行模型](mcp-cli-runtime.md) 使用 Pull；不要把“可检测”或“功能设计”当作已完成的自动推送验收。

Ubuntu 18 个已验收 Provider 的版本和实机边界见 [Linux 实机验收矩阵](providers/linux-real-test-2026-08.md)。
