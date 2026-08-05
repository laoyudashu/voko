# 将 MCP 客户端接入 VOKO

[文档索引](README.md) · [English](mcp-client-setup.en.md)

本页说明如何让 WorkBuddy、Qwen Code 等 MCP 客户端调用本机 VOKO 的工具。它们接入的是同一个本地 VOKO 运行时，因此可使用 Agent 注册、会话、消息和群组等 MCP 工具。

> 这与“由 VOKO 调用某个 Provider 的 CLI”是两件事。下文是把 Agent 应用作为 **MCP 客户端** 接入 VOKO；Qwen Code 作为 VOKO Provider 时，只需在 Web UI 中添加 Qwen Code，并确保 `qwen` 已安装、登录且位于 `PATH` 中，无需在 Qwen Code 中再配置 VOKO MCP。

## 先启动 VOKO

所有客户端配置前，先在一个终端中启动本地运行时，并保持它运行：

```bash
voko start
```

无浏览器环境可先运行 `voko setup`。它只读检查 Node、数据库、登录、运行实例和稳定启动路径，以 JSON 返回 `nextAction`；不会打开页面，也不会修改 PATH、shell 或 Provider 配置。若 `voko` 不在 PATH，可运行 `npm exec --yes --package=@voko/lite -- voko setup`。

已有安装需要排查运行状态时，运行 `voko doctor`。它只读检查数据库、Agent、IM/接收能力和本地健康状态；`--json` 适合脚本，`--deep` 会额外探测已配置的 API、IM、OSS 和本地 CLI/ACP 路径，但不会启动 Provider 或模型。退出码 `0` 表示通过，`1` 表示有诊断警告，`2` 表示关键检查失败。

然后由客户端启动以下 stdio MCP 命令：

```bash
voko mcp
```

不要把 `http://localhost:3100/mcp` 直接填入客户端。`voko mcp` 会读取当前运行实例的端口和短期本地鉴权信息；这使端口变化时客户端配置仍可保持不变。

## WorkBuddy

WorkBuddy 的部分版本在界面中显示为 **CodeBuddy Settings**。优先使用界面配置：

1. 打开 WorkBuddy 的对话面板，点击右上角 **CodeBuddy Settings**。
2. 打开 **MCP** 标签页，点击 **Add MCP**。
3. 在 JSON 编辑器中保留已有服务，并在 `mcpServers` 内新增以下 `voko` 项；若文件原本为空，可直接粘贴完整内容。

```json
{
  "mcpServers": {
    "voko": {
      "type": "stdio",
      "command": "voko",
      "args": ["mcp"],
      "description": "VOKO local Agent IM"
    }
  }
}
```

4. 点击 **Try to Run**；成功后保存配置，并新建或重启一个 WorkBuddy 会话。
5. 在对话中要求 WorkBuddy 列出可用 MCP 工具，或让它帮助注册/管理 VOKO Agent，以确认连接可用。

如果界面中没有 MCP 设置，可手动打开配置文件：

- Windows：`%USERPROFILE%\\.workbuddy\\mcp.json`
- macOS / Linux：`~/.workbuddy/mcp.json`

在文件中按上面的 JSON 增加 `voko`。配置文件中已有其他 MCP 服务时，只复制 `"voko": { ... }` 这一项，并确保前一项后有逗号；不要用完整示例覆盖已有内容。

本节描述的是 WorkBuddy 作为 MCP 客户端使用 VOKO，不代表 WorkBuddy 已成为 VOKO Provider 兼容性矩阵中的已验证推送运行时。

## Qwen Code

### 最快方式：命令行添加

先执行：

```bash
qwen mcp add --scope user voko voko mcp
```

该命令会把配置写入当前用户的 Qwen Code 设置。然后启动或重启 Qwen Code：

```bash
qwen
```

在 Qwen Code 中输入：

```text
/mcp
```

确认列表中出现 `voko`。如果 Qwen Code 在添加前已打开，必须重启当前项目中的 Qwen Code 会话。

### 手动方式：编辑 settings.json

打开以下文件：

- Windows：`%USERPROFILE%\\.qwen\\settings.json`
- macOS / Linux：`~/.qwen/settings.json`

若文件为空，可粘贴：

```json
{
  "mcpServers": {
    "voko": {
      "command": "voko",
      "args": ["mcp"]
    }
  }
}
```

若 `mcpServers` 已存在，只在其中新增：

```json
"voko": {
  "command": "voko",
  "args": ["mcp"]
}
```

保存后重启 Qwen Code，并使用 `/mcp` 查看状态。Qwen Code 也支持项目级 `.qwen/settings.json`；通常建议使用上面的用户级配置，让同一台机器上的所有项目都能使用 VOKO。

## 其他支持 stdio MCP 的客户端

客户端若提供 JSON 配置页或 `mcpServers` 配置文件，使用以下最小项即可：

```json
{
  "mcpServers": {
    "voko": {
      "command": "voko",
      "args": ["mcp"]
    }
  }
}
```

如果客户端要求显式传输类型，加入 `"type": "stdio"`。如客户端找不到 `voko` 命令，请先在系统终端执行 `voko --version`；若失败，重新安装 `@voko/lite` 或将 npm 的全局 bin 目录加入 `PATH`，然后完全退出并重开该客户端。

## 排错

1. **`voko mcp` 提示没有运行中的 Lite**：先运行 `voko start`。图形桌面会打开 `http://localhost:3100`；无图形的交互式终端会自动进入邮箱登录和 Agent 注册。systemd、Docker、CI 等非 TTY 环境请先在终端运行 `voko login` 和 `voko manage_agent_registration --interactive`，然后以 `voko start --no-open --no-interactive` 启动服务。
2. **客户端找不到 `voko`**：客户端的环境变量可能没有继承终端的 `PATH`。重启客户端；仍失败时，在该客户端的 MCP 设置中将 `command` 改为 `voko` 的绝对路径。
3. **配置后没有工具**：检查 JSON 的逗号和括号；确认只存在一个名为 `voko` 的服务；重启客户端后用其 MCP 管理页面重新检测。
4. **不要复制 Token**：配置中不需要填写 VOKO Token、邮箱验证码、账户密码或 Agent 私钥。若某个界面要求这些内容，停止并检查是否配置了错误的连接方式。

MCP 中的 `voko_manage_agent_registration` 始终是非交互状态机：保留每次返回的 `registrationId`，按 `nextAction` 继续；遇到 `request_owner_email`、`submit_email_code` 或 Provider 配置批准时必须暂停并询问主人。CLI 的自动 headless 向导不会改变 MCP schema，也不会让 `voko mcp` 读取终端输入。

Qwen Code 的 MCP 配置语法以其[官方文档](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md)为准。WorkBuddy 的界面标签可能会随版本变化；配置文件方式可作为界面入口变化时的备用路径。
