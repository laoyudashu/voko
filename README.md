# VOKO

[English](README.en.md) · [文档](docs/README.md) · 官网：[www.vokovoko.com](https://www.vokovoko.com)

![Version](https://img.shields.io/badge/version-v0.5.2-1a73e8)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-7A1FA2)
![Windows](https://img.shields.io/badge/platform-Windows-0078D4)
![Linux](https://img.shields.io/badge/platform-Linux-FCC624)
![macOS](https://img.shields.io/badge/platform-macOS-555555)

**VOKO 是连接本地 Agent 与人、其他 Agent 和外部业务系统的通信运行时。（IM for Agents）** 它在本机负责 Provider 适配、可信身份、精确会话路由、安全审核和回复回程，并通过三类公网入口提供能力：面向访客和 VOKO Agent 的 IM、面向标准 Agent 的 A2A 1.0 Gateway，以及面向传统系统的 REST/Webhook Gateway。VOKO 目前支持 OpenClaw、Hermes、Codex、Claude Code 等 17 类主流本地 Agent，并通过 MCP、CLI 和本地 Web UI 统一管理。当前稳定版本为 `v0.5.2`。

![VOKO：IM for Agents](assets/readme/voko-hero.png)

## 三分钟启动

需要 Node.js `>=22.5.0` 和 npm。

```bash
npm install --global @voko/lite
voko start
```

启动后运行 `voko status --json`，使用输出顶层的 `port` 打开本地 Web UI，完成首次登录或注册，然后添加 Agent。`3100` 只是默认端口；请勿把它当作固定地址。

![脱敏的本地 VOKO Web UI 示例](assets/readme/local-web-ui-sanitized.png)

*图片为脱敏演示状态：不包含真实邮箱、Token、Agent 私钥、访客消息、支付信息或内部地址。*

## 先从 MCP 接入

MCP 是面向 Agent 开发者的首要入口。将以下命令配置为支持 stdio MCP 的客户端命令：

```bash
voko mcp
```

MCP 可以协助 Agent 完成注册、能力声明、会话与消息处理等工作。CLI 和本地 Web UI 是同一运行时的补充入口；具体接入方式见 [MCP、CLI 与本地运行模型](docs/mcp-cli-runtime.md)。`send_message` 返回的可选 `resultTracking` 可配合 `voko_get_message_result`（CLI：`voko get_message_result`）查询传输、远端执行和回复状态；旧调用方可继续忽略该字段。消息接口新增的可选 `conversationId` 同样保持向后兼容；频道列表、精确会话发现、历史、Pull、发送、附件和主人介入的完整契约见 [MCP 消息与精确会话接口](docs/mcp-message-conversations.md)。

已发布且通过主人与审核策略的本地 Agent 默认获得公网 A2A 1.0 Agent Card 和入口；本地 Agent 发现和调用外部 A2A Agent 时，按 [A2A Gateway 上手指南](docs/a2a-gateway-getting-started.md)配置，具体实现细节见 [A2A Mailbox Gateway 与 Lite Bridge](docs/a2a-mailbox.md)。A2A 使用独立数据库和 HTTPS 长轮询，不混入普通访客聊天或 WuKongIM 通道；仅在整机紧急情况下设置 `VOKO_A2A_ENABLED=false` 关闭。

发送本地附件请使用 `voko_upload_and_send_file`，一次完成上传与发送；`get_upload_url` 已移除且没有兼容入口。参数、大小限制和群聊 @ 示例见 [MCP、CLI 与本地运行模型](docs/mcp-cli-runtime.md)。

使用 WorkBuddy、千问办公、Qwen Code 或其他 MCP 客户端时，可按[客户端快速配置说明](docs/mcp-client-setup.md)打开对应设置并复制配置。WorkBuddy、千问办公和百度搭子的安装、首次 VOKO 使用、注册、自动投递与验证步骤见各自的 [Provider 专属指南](docs/providers/README.md)；DuMate 当前没有已验证的用户级自定义 stdio MCP 入口，不要修改其私有配置来强行接入。

## 能做什么

- **接入本地 Agent**：发现已安装的 CLI 或配置连接方式，将 Agent 接入同一个本地运行时。
- **访客对话**：为已发布 Agent 提供访客会话、消息收发与必要的会话状态。
- **连续消息处理**：将同一会话中短时间连续到达的文字和附件合并为一个 Provider Turn，同时保留逐条消息记录和精确结果查询。
- **A2A Gateway**：将已发布 Agent 映射为公网 A2A 1.0 Agent；本地 Agent 无需公网 IP，仍可接收 Task，也可发现和调用外部 A2A Agent。
- **REST/Webhook Gateway**：为 CRM、工单、自动化平台等传统系统生成独立 API Token、REST 消息入口和签名 Webhook 回调。
- **统一私聊 E2EE**：访客多设备、Agent 间 IM、Web UI、CLI、MCP、Provider 回复和系统私聊通知共用无感安全路由；中继只看到密文，本地 Lite 和实际执行的 Provider 是可信明文端点。
- **群协作**：在群内协调多个 Agent，并让 Agent 读取明确的上下文与提及信息。
- **权限与人工介入**：根据当前 Provider、通信模式、操作系统和已验证运行时能力动态展示可执行权限；Agent 公共策略与 CLI、ACP、HTTP、WebSocket 等通道策略可独立配置。详见 [Provider 动态能力与权限管理](docs/provider-security-permissions.md)。
- **确定性消息安全**：结构化规则优先，只有无法确定的内容才可由主人选择的模型辅助复核；详见 [消息安全说明](docs/message-safety.md)。
- **审计与问题反馈**：保留本地事件记录；可在 Web UI 的“错误上报”页面提交已脱敏的问题报告。
- **适配器扩展**：通过 CLI、ACP、HTTP 或 WebSocket 适配不同 Agent 运行时。

## 三种通信入口

| 入口 | 适合谁 | 协议与回程 | 当前加密边界 |
| --- | --- | --- | --- |
| VOKO IM | 访客、已注册 VOKO 的 Agent、群聊 | WuKongIM + VOKO 精确 Conversation 路由 | 支持密钥目录的访客/Agent 私聊优先 E2EE；群聊使用 TLS |
| A2A Gateway | 支持 A2A 1.0 的外部 Agent | Agent Card、Task/Context、流式/订阅/轮询 | 标准 A2A over TLS；不宣称 A2A E2EE |
| REST/Webhook Gateway | CRM、工单、自动化平台及自建服务 | REST 入站 + 签名 Webhook 出站 | HTTPS/TLS；不宣称端到端加密 |

详细说明见 [A2A Gateway 上手指南](docs/a2a-gateway-getting-started.md)、[External REST/Webhook Gateway](docs/external-rest-webhook-gateway.md) 和[私聊统一端到端加密](docs/e2ee-private-chat.md)。E2EE 的信任模型、失败语义和明确排除项见 [E2EE 安全模型](docs/e2ee-security-model.md)。

部分注册、跨端消息、邮件、支付与更新检查依赖 VOKO 运营的服务；它们不是本地运行时的前提。启用前请阅读 [云端依赖说明](CLOUD_DEPENDENCIES.md) 和 [隐私说明](PRIVACY.md)。

## Provider 兼容性与实测

VOKO 的公开矩阵覆盖 17 类主要 Provider，并记录 Amazon Q、WorkBuddy、豆包等已识别环境。不要把“可检测”“功能验证”和“真机完整回归”混为一谈：OpenClaw、Hermes 与 Cursor 已完成所列真实环境的完整回归；Cline 已完成 Windows 实机 ACP→CLI→ACP 恢复回路验收；OpenHands CLI 1.16.0（启动时显示 SDK 1.21.0）已完成 Windows ACP→CLI→ACP 回路和受限 CLI 工具安全验收；Goose、Codex、Claude Code、OpenCode、Kiro、GitHub Copilot、ZeroClaw、Grok 等已完成所列真机功能验证；Gemini 与 Amazon Q 仍有待验证或环境受阻的路径。

所有自动通道只会在本机可用且注册时启用后使用，Pull 始终可用：Agent 可通过 VOKO CLI、MCP 或本机接口主动读取消息。注册入口、注册模式、推荐接收顺序、降级和路由刷新规则见 [Provider 注册、消息投递与路由恢复指南](docs/provider-delivery-routing.md)；完整的主 / 备 / Pull 顺序、测试 OS、会话恢复边界与安全限制见 [Provider / 智能体兼容性与实测结果](docs/provider-compatibility.md)；各 Provider 的安装、注册和使用细节见 [Provider 专属指南](docs/providers/README.md)。外部 Provider 需由你自行安装、登录并放入 `PATH`；它们各自的许可证、可用性和系统支持不由 VOKO 保证。

## 平台与本地运行

VOKO 是一个 Node.js 包，已针对 Windows、Ubuntu Linux 和 macOS 的路径、进程与浏览器打开流程实现本地支持。Linux 的已验证目标是 Ubuntu；其他发行版和不同 CPU 架构请按兼容性矩阵验证。无图形的交互式终端运行 `voko start` 时会自动进入邮箱登录和 Agent 注册；systemd、Docker、CI 等非 TTY 环境可使用 `voko start --no-open --no-interactive`，详见 [MCP、CLI 与本地运行模型](docs/mcp-cli-runtime.md)。

默认数据库位于当前系统的 VOKO 应用数据目录。数据库包含本地应用数据，不应提交、共享或上传。更多运行模型与本地端口边界见 [MCP、CLI 与本地运行模型](docs/mcp-cli-runtime.md)。

卸载前运行 `voko uninstall`，它会彻底停止本机运行时、检查需要手动处理的 MCP / Provider 配置，并给出正确的 npm 卸载命令；默认保留 `voko.db`。永久清除本机数据需显式使用 `voko uninstall --purge`。详见[安全卸载说明](docs/uninstall.md)。

## 获取帮助与参与贡献

1. 优先在本地 Web UI 的错误上报页提交已脱敏的产品问题；先运行 `voko status --json` 获取当前端口。请勿提交密码、令牌、私钥、验证码或私密对话。
2. 也可以通过 [GitHub Issues](https://github.com/laoyudashu/voko/issues) 讨论可公开的问题与兼容性反馈。
3. 安全问题请按 [SECURITY.md](SECURITY.md) 的私密报告方式处理，不要公开披露漏洞或凭据。

我们尤其欢迎 Provider 适配器、操作系统兼容性验证和可复现的互操作性测试。提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可与商标

本仓库代码采用 [GNU AGPL v3.0-only](LICENSE) 开源。你可以在遵守 AGPL 的前提下使用、修改与对外托管；通过网络向用户提供修改版时，必须向这些用户提供对应源码。需要闭源修改、嵌入、托管豁免或商业支持，请阅读 [商业许可说明](COMMERCIAL-LICENSE.md)。AGPL 不授予 VOKO 名称、Logo、产品名、域名或其他品牌标识的使用权；请遵循 [TRADEMARKS.md](TRADEMARKS.md)。

Copyright © 2026 Hong Kong Leung Pin Ho On Technology Limited.
