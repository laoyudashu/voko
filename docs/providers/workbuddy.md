# WorkBuddy

WorkBuddy 与 VOKO 有两个不同方向：

- **WorkBuddy → VOKO**：WorkBuddy 作为 MCP 客户端调用 `voko mcp`。
- **VOKO → WorkBuddy**：VOKO 使用独立安装并登录的 CodeBuddy CLI，通过本机 HTTP/ACP 自动投递新消息。

## 自动投递顺序

```text
WorkBuddy HTTP → Pull
```

## 自动投递前置条件

标准 WorkBuddy Desktop 安装默认不包含系统全局可用的 `@tencent-ai/codebuddy-code`。VOKO 自动投递前需要单独完成：

```bash
npm install -g @tencent-ai/codebuddy-code
codebuddy /login
```

全局 CLI 与 WorkBuddy Desktop 使用不同的登录状态；即使桌面应用已经登录，首次使用全局 CLI 时仍需在浏览器中单独授权一次。登录通常会在本机持久化，凭据过期、主动退出或本机凭据被清除后需要重新登录。安装完成但未登录时，CLI 会返回 `Authentication required`，此时不能视为自动投递可用。

VOKO 优先使用系统 `PATH` 中独立安装的新版 `codebuddy`；找不到时才尝试桌面应用内置 CLI。当前已验证的 WorkBuddy 内置 CLI 2.115.0 可能创建会话后长期不返回完成事件，因此“发现桌面应用”或“HTTP 服务启动成功”都不能作为可转发结论。只有真实 loopback 收到并精确匹配模型回复后，才应将自动投递标记为可用。

VOKO 启动的服务只监听 `127.0.0.1`，使用动态端口；停止 Lite 时只关闭自己启动的服务，不关闭 WorkBuddy 桌面应用。新版 CLI 默认启用网关认证；VOKO 仅对自己创建的随机回环端口关闭网关密码，并继续携带 `X-CodeBuddy-Request: 1` 安全请求头。

VOKO 使用 ACP 会话提交消息并复用精确的原生 Session ID。无法确认结果时标记为结果未知，不重复提交消息。Pull 始终保留；缺少 CLI、尚未登录或真实 loopback 失败时，应继续使用 Pull，而不是显示自动投递已就绪。

## 注册与资料预填

注册第一步只发现 WorkBuddy 桌面版中的 Expert。用户选择 Expert 后，第二步使用该 Expert 清单中的名称、描述、分类、标签、联系电话和地址生成可编辑建议；存在受控头像候选时，通过 VOKO 本机预览接口显示。头像仍必须经过目录边界、大小和真实图片类型校验，并在 Agent 创建后走正常上传流程；本机插件路径不会保存为公开 URL。

用户在第二步最终确认或修改的资料会随本次 Agent 注册同步到服务端。发现资料缺失时仍可手工填写，VOKO 不读取 WorkBuddy 项目提示词或会话正文来补全描述。

## 会话与安全

- 每个 VOKO Agent、访客、群聊、Owner 和 A2A Context 使用不同的不透明会话作用域。
- WorkBuddy 返回的原生 Session ID 只保存在本机 Provider 会话绑定中，不写入日志或远程服务。
- 外部访客消息仍先经过 VOKO 现有审核与安全上下文。
- VOKO 管理的 WorkBuddy HTTP 服务使用 `dontAsk`、空工具集和严格 MCP 配置，访客消息不能调用 CodeBuddy 工具或用户/项目 MCP Server。
- 该限制只约束 VOKO 管理的消息通道；WorkBuddy 桌面应用自身的文件、网络、命令和人工审批能力仍由 WorkBuddy 管理。
- `X-CodeBuddy-Request: 1` 是协议头，不是网络认证，因此 VOKO 不允许服务监听局域网或公网地址。

## 安装与检测建议

VOKO 不应在后台静默执行全局 npm 安装或替用户完成腾讯账号授权。推荐的产品流程是：

1. 分别显示“WorkBuddy Desktop”“独立 CodeBuddy CLI”“CLI 登录/真实回路”三层状态。
2. CLI 缺失时显示安装命令 `npm install -g @tencent-ai/codebuddy-code`，保留 Pull，并允许用户安装后重新检测。
3. CLI 已安装但真实测试返回 `Authentication required` 时显示 `codebuddy /login`，完成浏览器授权后重新测试。
4. 只有真实模型 loopback 成功时启用并默认选择 HTTP 自动投递；仅检测到可执行文件时状态应为“待验证”。
5. CLI 升级和卸载仍由 npm/系统包管理器负责，VOKO 不锁定或覆盖用户已有版本。

## 兼容性基线

macOS 真机已验证全局 CodeBuddy CLI 2.139.0 完成登录后，VOKO HTTP/ACP loopback、精确回复匹配和会话清理成功。WorkBuddy Desktop 内置 CLI 2.115.0 能启动并创建会话，但本次回归中未能在超时前返回模型完成事件。Windows 真机确认标准环境没有 WorkBuddy Desktop/内置 CLI；全局 CLI 2.139.0 未登录时明确返回 `Authentication required`，完成独立登录后的 VOKO 成功回路仍需继续验收。HTTP API 仍为 Beta，VOKO 每次启动都会检查实际 OpenAPI 是否包含必需路由；不满足时自动保留 Pull。
