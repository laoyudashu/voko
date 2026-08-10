# Windows + Ubuntu 双机生产环境测试

这份手册用于复用同一台 Windows 主机和其 WSL Ubuntu 实例进行 VOKO 双机真实环境测试，避免每轮重新定位 Node、VOKO、数据库、端口和跨端测试 Agent。

## 本机配置来源

- 通用真实测试继续使用 `.env.real-test.local`。
- 双机定位信息使用仓库根目录的 `.env.dual-machine.local`。
- `.env.dual-machine.local` 已被现有 `.env.*` 规则忽略，不得提交。
- 文件只能保存数据库路径、端口、可执行文件路径、Agent ID、IM UID和测试群 ID；不得保存 Token、密码、Provider API Key、原生 Session ID或完整提示词。

开始测试前先读取本地文件，不要重新猜测 WSL PATH或数据库位置。

## 固定拓扑

```text
Windows VOKO (localhost:3100)
  DB: %APPDATA%\voko\voko.db
          ⇅ WuKongIM / 正式服务
Ubuntu VOKO in WSL (localhost:33100 inside WSL)
  DB: /home/tjyu/.config/voko/voko.db
```

WSL非交互 shell 不加载 `.bashrc`。执行 Ubuntu VOKO/MCP时必须显式使用本地文件中的 `UBUNTU_NODE_BIN` 和 `UBUNTU_VOKO_BIN`，并构造：

```text
PATH=<node bin directory>:/home/tjyu/.local/bin:/usr/local/bin:/usr/bin:/bin
```

不要调用裸 `node`，也不要让 `/mnt/c/...` Windows shim排在 Linux入口前面。

## 每轮最小预检

1. `voko status` 确认 Windows运行、schema版本正确、Agent已加载。
2. 通过 WSL中的绝对 VOKO路径执行 `voko status`，确认 Ubuntu运行。
3. 从双端数据库按 `agent_id` 读取当前 `imUid`，不要假设历史 IM UID永久不变。
4. 确认测试发送者已在目标 Agent白名单中；目标为 private且未加入白名单时先补齐。
5. 双端出入站审核保持 `allow`，避免 Provider正常回复被关键词审核拦截。
6. 测试前确认 Provider真实登录、模型可用及对应 Push入口可执行。
7. 使用唯一标记消息；不删除生产测试消息。

## 跨端发送

推荐让 Ubuntu已发布 Codex测试 Agent充当稳定发送者，调用 Ubuntu运行实例的 MCP `voko_send_message`，目标使用 Windows Agent的 `imUid`。反向测试则交换 Agent和 IM UID。

通过 WSL执行 MCP时使用如下结构，具体值从 `.env.dual-machine.local` 读取：

```powershell
$json | wsl env `
  PATH=<UBUNTU_NODE_DIR>:/home/tjyu/.local/bin:/usr/local/bin:/usr/bin:/bin `
  VOKO_DB_PATH=<UBUNTU_DB_PATH> `
  <UBUNTU_VOKO_BIN> mcp
```

MCP输入为一行 JSON-RPC。不要把认证信息放在命令行；stdio代理会从本机数据库和运行快照取得受保护的本地认证上下文。

## ACP降级与恢复测试

1. 先发送基线消息，确认 ACP真实回复并产生 ACP子进程。
2. 通过完整命令行和 PID精确定位目标 Provider ACP进程。
3. 终止前再次校验 PID和命令行，不能按模糊进程名批量终止。
4. 记录 unavailable、降级通道和回复数量。
5. 自动恢复应产生新的 PID，并通过 availability事件刷新 Dispatcher路由。
6. 再发一条唯一标记消息，确认一入一出、没有重复回复。
7. OpenCode ACP → CLI必须观察到 `opencode run --session <id>`；日志和报告只能记录布尔结果，不记录原生 ID。
8. `outcome_unknown` 不跨通道重投；Provider模型无响应时不能用重复发送伪造成功。

## 群聊精确路由

- 使用本地文件中的生产测试群。
- 先确认双端测试 Agent都是当前群成员。
- Session A/B向同一群交错发送，反向按 B/A乱序回复。
- 验证 A消息只回 A、B消息只回 B；随后重启 VOKO再次引用旧 Route验收持久化。
- 群精确路由仅接受文字、明确且合法的 `replyToRouteId`；非法 Route必须 fail-closed。

## 测试结束

- 保留审核策略 `allow` 和已建立的测试白名单，供后续生产验收复用。
- 保留测试消息。
- 确认 VOKO双端仍运行、ACP恢复任务没有遗留重复进程。
- 报告只记录 Provider类型、版本、通道、耗时、回复数量和通过/失败，不记录敏感身份材料。

