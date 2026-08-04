# 卸载 VOKO Lite

[文档索引](README.md) · [English](uninstall.en.md) · [日本語](uninstall.ja.md)

运行 `voko uninstall` 会复用 `voko stop` 的实例身份校验流程，彻底停止 VOKO 及身份匹配的 Worker、检查 MCP 和 Provider 配置残留，并显示适合当前安装方式的 npm 卸载命令。它不会自行删除 npm 包、停止 Provider 服务或修改第三方配置。重复执行以及 VOKO 本来没有运行均属于正常情况。

```bash
# 停止并准备卸载，保留本机数据
voko uninstall

# 只预览，不停止进程或删除数据
voko uninstall --dry-run

# 输出供 Agent / 自动化读取的 JSON
voko uninstall --json
```

默认保留本机数据目录和 `voko.db`，重新安装后可以继续使用。默认目录为：

- Windows：`%APPDATA%\voko`
- macOS：`~/Library/Application Support/voko`
- Linux：`$XDG_CONFIG_HOME/voko`，未设置时为 `~/.config/voko`

永久删除登录信息、Agent、消息、本机会话绑定、运行状态和本地日志时使用 `voko uninstall --purge`，并输入 `DELETE VOKO DATA`。非交互环境必须显式使用 `voko uninstall --purge --yes`。自定义 `--db` 或 `VOKO_DB_PATH` 不会被自动删除；根目录、用户主目录、符号链接、目录联接和不明确的目标也会被拒绝。

命令只会列出明确指向 VOKO 的 MCP 条目，以及可能由注册配置流程涉及的 OpenClaw / Hermes 配置位置；不会输出配置正文、Token 或密钥。请在确认这些配置不再被其他工作流使用后手动处理。

卸载不会删除 AgentDID 账号、远程 Agent、服务端消息、白名单或其他访问控制数据。这些云端数据需要通过相应的远程管理流程单独处理。
