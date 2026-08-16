# Trae 专属指南

[文档导航](../README.md) · [Provider 行为矩阵](../provider-transport-matrix.md) · [投递路由](../provider-delivery-routing.md) · [MCP 客户端配置](../mcp-client-setup.md)

本页区分 Trae 桌面 IDE 和独立的 Trae CLI：

- **桌面 `trae`**：MCP 客户端，可以调用 VOKO；它不是 VOKO 可启动的 ACP 服务。
- **独立 `traecli`**：企业版/特定发行版提供的无头 CLI，若本机安装并通过 `traecli acp serve` 验证，则作为 VOKO 的 ACP Push 通道。

## 本机验收结果（Windows）

本机发现桌面入口：

```text
%LOCALAPPDATA%\\Programs\\Trae\\bin\\trae.cmd
Trae desktop: 1.107.1（版本可能随自动更新变化）
```

`trae.cmd --help` 显示 Electron/VS Code 风格 IDE 参数，并提供 `--add-mcp`；没有 `acp serve` 或稳定的无头消息 API。当前 PATH 和 Trae 安装目录均未发现 `traecli` / `traecli.exe`，因此本机尚未执行真实 ACP 回路。

独立 CLI 的入口需要单独安装和登录。官方社区目前将 Trae CLI 描述为企业版或特定发行版能力；不要把桌面 `trae.cmd` 重命名为 `traecli`，也不要用 GUI 自动化冒充 Push 通道。

官方参考：[Trae MCP 常见问题](https://forum.trae.cn/t/topic/65)、[Trae CLI 安装讨论](https://forum.trae.cn/t/topic/15100)。具体 CLI 能力以当前发行版的帮助输出和企业策略为准。

## VOKO → Trae：ACP → Pull

Catalog 顺序为：

```text
backend_type: trae
delivery_modes: ["acp", "pull"]
```

当本机存在 `traecli` 时，VOKO 启动：

```text
traecli acp serve --yolo
```

ACP 使用独立 stdio 会话、原生 session ID 和 Dispatcher 会话绑定；权限策略由 VOKO 默认拒绝/隔离。ACP 进程不可用时，消息保留在 VOKO 并进入 Pull，不会启动桌面 IDE，也不会把旧 ACP binding 传给不兼容的通道。

可使用固定路径覆盖默认解析：

```powershell
$env:VOKO_TRAECLI_BIN = 'D:\\path\\to\\traecli.exe'
traecli.exe --version
traecli.exe acp serve --help
```

只有 `traecli acp serve --help` 成功且登录/租户认证完成后，注册预检才会把 ACP 标记为 `ready`。本机没有 `traecli` 时，诊断应显示 ACP `unavailable`，而不是把桌面 Trae 判定为后端断开。

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
