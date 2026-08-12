# 千问办公（QwenWork）专属指南

[文档导航](../README.md) · [Provider 行为矩阵](../provider-transport-matrix.md) · [投递路由](../provider-delivery-routing.md) · [MCP 客户端配置](../mcp-client-setup.md)

本页区分两个方向：

- **千问办公 → VOKO**：千问办公作为 MCP 客户端调用 VOKO 工具，适合注册 Agent、发送消息和主动读取消息。
- **VOKO → 千问办公**：VOKO 使用 QwenWork 安装包内的 `qoderclicn` 非交互 CLI 发送消息；CLI 不可用或未登录时再回退 Pull。

`qwen-office` 与 `qwen-code` 是不同的 Provider 类型，不要混用配置或登录状态。

官方参考：[千问办公产品介绍](https://qwenwork.cn/docs/product-introduction)、[桌面端 IM 频道](https://qwenwork.cn/docs/desktop/im-channels)。

## VOKO → 千问办公：CLI → Pull

Catalog 顺序为：

```text
backend_type: qwen-office
delivery_modes: ["cli", "pull"]
```

### CLI 登录

VOKO 使用 QwenWork 安装包提供的 `qoderclicn` 无头 CLI。桌面端显示已登录，不代表 CLI 已完成授权；首次使用前，在 VOKO 实际调用的同一个 CLI 上执行：

```powershell
qoderclicn.exe login
qoderclicn.exe status --output json
```

`status` 必须返回 `"logged_in": true`。登录会通过浏览器完成 QoderCN 账号授权；不要把二维码、Cookie 或 Token 复制到 VOKO 配置。登录后重启 VOKO，或执行 `voko doctor --deep` 让预检刷新状态。CLI 未登录时，VOKO 不会把 `cli` 标记为 ready，只保留 Pull。

CLI 使用以下安全参数：

```text
--print
--output-format stream-json
--input-format stream-json
--permission-mode dont_ask
--tools ""
```

### 创建与验证

在 VOKO 的“添加 Agent”流程中选择“千问办公（QwenWork）”，消息接收顺序保持：

```text
QwenWork CLI 自动交付 → 主动获取
```

创建完成后，点击“验证消息链路”。该操作会实际执行一次无工具模型调用，并校验 VOKO 生成的随机 challenge 是否经 `qoderclicn` 原样返回。验证过程中可能产生少量模型费用和一个本地测试会话；验证成功后按钮显示绿色“验证成功”。

“验证消息链路”与运行时预检不同：运行时预检只确认可执行文件和 CLI 登录状态，不调用模型；消息链路验证同时覆盖运行时解析、stdin stream-json 输入、模型调用、stdout 解析和 challenge 校验。

访客文本通过 stdin 作为 JSON 消息传入，不拼接到 shell 命令；工具和权限请求默认关闭。成功建立会话后，Provider 保存 QwenWork 原生 `session_id`，后续消息优先续接同一会话。`not_delivered` 才允许进入 Pull；认证失败、结果未知或业务拒绝不会跨通道重复发送。

QwenWork 的 `qoderclicn` 属于当前安装包提供的本地运行时，不是公开稳定 API。升级 QwenWork 后应重新执行版本、帮助和非交互协议探测；如安装位置不同，可设置：

```powershell
$env:VOKO_QWENWORK_CLI_BIN = 'D:\\path\\to\\qoderclicn.exe'
```

## 千问办公 → VOKO：自定义 MCP

在千问办公的 **设置 → 连接器 / MCP → 自定义 MCP** 中添加 VOKO stdio Server：

```json
{
  "name": "voko",
  "config": {
    "command": "voko",
    "args": ["mcp"]
  }
}
```

如果界面要求 `mcpServers` 结构，则使用：

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

重启千问办公后，在工具列表中确认 VOKO 工具可见。自定义 MCP 只代表 Agent 能主动调用 VOKO，不会替代 VOKO→Agent 的 CLI 投递通道。

## 检查与排障

```powershell
voko status --json
voko doctor --deep
qoderclicn.exe status --output json
```

- `logged_in=false`：在 VOKO 实际使用的 `qoderclicn.exe` 上执行 `login`；仅登录桌面 QwenWork 不足以让 CLI 通道 ready。
- `automaticReadyModes=["cli"]`：CLI 可用，消息按 CLI → Pull 顺序投递。
- `automaticReadyModes=[]`：当前只保留 Pull；消息仍持久化，不会丢失。
- 不要启动 `QwenWorkCN.exe` GUI 来模拟 Push，也不要通过桌面自动化或 shell 注入访客文本。

## 已验证能力

Windows 真机已使用 QwenWork `qoderclicn` 1.0.47 完成以下验收：

- 注册页“验证消息链路”成功，随机 challenge 精确匹配。
- 已创建的 `qwen-office` Agent 通过真实 VOKOVOKO/WuKongIM 接收另一 Agent 的单聊消息。
- 消息经 QwenWork CLI 自动交付并生成回复，回复成功写入本地数据库并通过真实 IM 返回对端。
- 入站和出站消息均收到 SENDACK；数据库各只保存一份，无丢失或重复。
- Agent-to-Agent 对话触发既有收敛机制后停止，没有形成无限自动回复循环。

该结果证明 `IM → VOKO → qoderclicn → QwenWork → VOKO → IM` 完整生产链路可用。QwenWork 或 `qoderclicn` 升级后，仍应重新执行“验证消息链路”。

## 安全边界

VOKO 不读取 QwenWork Token、邮箱验证码、工作区内容或内部配置；只读取版本和登录状态探针。`qoderclicn` 的未来版本若改变参数或协议，应先重新做本机验收，再启用 CLI 通道。
