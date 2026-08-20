# Trae 专属指南

[文档导航](../README.md) · [Provider 行为矩阵](../provider-transport-matrix.md) · [投递路由](../provider-delivery-routing.md) · [MCP 客户端配置](../mcp-client-setup.md)

本页区分 Trae/TraeWork 桌面应用和独立的 Trae CLI：

- **桌面 `trae` / TraeWork CN**：MCP 客户端，可以调用 VOKO；它不是 VOKO 可启动的 ACP 服务，也不与 Trae CLI 共享桌面会话。
- **独立 `traecli`**：企业版/特定发行版提供的无头 CLI，若本机安装并通过 `traecli acp serve` 验证，则作为 VOKO 的 ACP Push 通道。

## 本机验收结果（Windows）

本机发现桌面入口与独立 CLI：

```text
%LOCALAPPDATA%\\Programs\\Trae\\bin\\trae.cmd
Trae desktop: 1.107.1（版本可能随自动更新变化）
TraeWork CN: 0.1.51
Trae CLI: 0.120.52
```

Trae 与 TraeWork 的桌面启动器都是 Electron/VS Code 风格入口，没有公开的无头 Push API。独立 Trae CLI 提供 `acp serve`；VOKO 已验证官方用户级安装目录发现、ACP initialize 和安全参数。当前 Windows Trae CLI 0.120.52 显示 Enterprise 发行版特征且没有登录入口；它虽然能识别引用 `DEEPSEEK_API_KEY` 的 DeepSeek 配置，但首次模型请求仍要求不存在的企业 Keyring 凭证。因此模型回复闭环尚不能标记为通过，这不是 DeepSeek Key 校验失败。

独立 CLI 的入口需要单独安装、登录并配置模型。不要把桌面启动器重命名为 `traecli`，不要调用 TraeWork 私有内部进程，也不要用 GUI 自动化冒充 Push 通道。

官方参考：[Trae MCP 常见问题](https://forum.trae.cn/t/topic/65)、[Trae CLI 安装讨论](https://forum.trae.cn/t/topic/15100)。具体 CLI 能力以当前发行版的帮助输出和企业策略为准。

## VOKO → Trae：ACP → Pull

Catalog 顺序为：

```text
backend_type: trae
delivery_modes: ["acp", "pull"]
```

当本机存在 `traecli` 时，VOKO 启动：

```text
traecli acp serve --permission-mode plan --disallowed-tool Bash --disallowed-tool Edit --disallowed-tool Write
```

ACP 使用独立 stdio 会话、原生 session ID 和 Dispatcher 会话绑定；权限策略由 VOKO 默认拒绝/隔离。ACP 进程不可用时，消息保留在 VOKO 并进入 Pull，不会启动桌面 IDE，也不会把旧 ACP binding 传给不兼容的通道。

可使用固定路径覆盖默认解析：

```powershell
$env:VOKO_TRAECLI_BIN = 'D:\\path\\to\\traecli.exe'
traecli.exe --version
traecli.exe acp serve --help
```

只有 `traecli acp serve --help` 成功且 `traecli doctor` 确认模型配置有效后，注册预检才会把 ACP 标记为 `ready`。已安装但未配置模型时显示 `configuration_required`；未安装时显示 `unavailable`。

Trae CLI 0.120.52 的 Windows 发行版实际用户配置文件为 `~/.trae/trae_cli.yaml`；其内置文档仍显示 `traecli.yaml`。模型密钥应使用 `${DEEPSEEK_API_KEY}` 等环境变量引用，不要把真实 Key 写入配置文件。

## Trae → VOKO：自定义 MCP

在 Trae 的 MCP 设置页添加 VOKO stdio Server：

```json
{
  "mcpServers": {
    "voko": {
      "type": "stdio",
      "command": "voko",
      "args": ["mcp"]
    }
  }
}
```

部分版本支持命令行：

```powershell
trae --add-mcp '{"name":"voko","command":"voko","args":["mcp"]}'
```

重启 Trae 后确认 VOKO 工具出现在 MCP 工具列表。MCP 客户端配置只负责 Trae 主动调用 VOKO，不会让 VOKO 获得桌面窗口的 Push 能力。

## 检查与排障

```powershell
trae --version
trae --help
voko status --json
voko doctor --deep
```

- 只有桌面 `trae.cmd`：使用 MCP + Pull；不要把它注册为 CLI Push。
- `traecli` 已安装但 ACP 不可用：先独立执行 `traecli --version` 与 `traecli acp serve --help`，再检查 CLI 登录和企业策略。
- `automaticReadyModes=["acp"]`：ACP 可用，按 ACP → Pull 投递。
- `automaticReadyModes=[]`：只保留 Pull；消息仍持久化，不会丢失。

## 安全边界

VOKO 不读取 Trae Token、工作区内容或桌面会话数据；不通过 shell 拼接访客消息，不启动 IDE 自动化。`traecli` 的命令行参数或 ACP 协议发生变化时，必须重新完成本机帮助、握手和消息回路验收后再启用。
